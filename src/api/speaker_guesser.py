"""
Transcribblr — Speaker guessing for unassigned records
Walks every record that has a transcription but no speaker assignment, asks
Qwen to guess which character is speaking based on the project's character
roster, scene context, story summary, and surrounding dialogue.

Suggestions land at entries[i].speaker_suggestion = {
  en, ja, confidence: 'high'|'medium'|'low', note
}
…so they coexist with manual assignments. The Edit → Speakers sub-tab and
the Tools → Speakers sub-tab both surface them with Accept / Dismiss
controls. Accepting copies the suggestion into entries[i].speaker (the
canonical field) and removes the suggestion.
"""

import os
import re
import json

import config
from logger import log
import translate_advanced as _adv


# ── System prompt ────────────────────────────────────────────────────────────

SYSTEM_PROMPT = (
    "You are a professional script editor working on an anime production. "
    "The transcription has Japanese dialogue but most lines have no speaker "
    "tag. Your job is to identify, where possible, which CHARACTER from the "
    "roster is most likely speaking each line.\n\n"
    "PRIORITY ORDER for picking a speaker (use higher-priority signals first):\n"
    "  1. ACTIVE SCENE(S) — only characters who plausibly fit this scene's "
    "description should be considered. If the scene is `Frontier confronts "
    "Ukita in the ape city`, the speakers are almost certainly Frontier "
    "and/or Ukita, NOT characters who appear in other scenes.\n"
    "  2. RECENTLY SEEN SPEAKERS — the list of characters confirmed to be "
    "speaking within ±8 records of the chunk. The chunk's speakers are "
    "almost always from this set. Prefer one of these over any other "
    "character on the roster.\n"
    "  3. CONTEXT records' [SPEAKER: …] tags — the immediate neighbour "
    "speaker is often the same person continuing, or the person they're "
    "addressing.\n"
    "  4. Speech style / register / pronouns matching a character's profile "
    "from the CHARACTERS roster — only as a tiebreaker among candidates "
    "from steps 1–3.\n\n"
    "DO NOT pick a character just because they exist on the roster. If "
    "they aren't in the active scene AND aren't in the recently-seen list "
    "AND aren't in the context records, they almost certainly aren't "
    "speaking here — output `?` instead.\n\n"
    "OUTPUT FORMAT — one block per record, blank lines between:\n"
    "<idx>: <Character Name>\n"
    "*Note: high|medium|low confidence — name the specific signal you used "
    "(active scene / recently seen / context line N / speech style)*\n\n"
    "If you can't make a confident guess, output instead:\n"
    "<idx>: ?\n"
    "*Note: brief reason — what was missing (no scene match, no recent "
    "speaker fits, ambiguous between X and Y, etc.)*\n\n"
    "RULES:\n"
    "- Only use character names from the CHARACTERS roster verbatim. "
    "Never invent or paraphrase names.\n"
    "- Be CONSERVATIVE — prefer '?' over a guess you're not confident about. "
    "It's better to leave a line unassigned than to mislabel it.\n"
    "- One block per record in the input. Cover every <idx> in the AUDIT "
    "block, even if the answer is '?'.\n"
)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _ja_of(entry):
    text = entry.get('text') if isinstance(entry, dict) else None
    if isinstance(text, dict):
        return (text.get('ja') or '').strip()
    if isinstance(text, str):
        return text.strip()
    return ''


def _is_transcribed(ja):
    return bool(ja) and '????' not in ja


def _existing_speaker(e):
    sp = e.get('speaker') if isinstance(e, dict) else None
    if isinstance(sp, dict):
        return (sp.get('en') or sp.get('ja') or '').strip()
    if isinstance(sp, str):
        return sp.strip()
    return ''


def find_unassigned_indices(subs):
    """Indices of transcribed records with no speaker AND no existing
    suggestion (so we don't keep re-asking about the same lines)."""
    out = []
    for i, e in enumerate(subs):
        if not isinstance(e, dict):
            continue
        if not _is_transcribed(_ja_of(e)):
            continue
        if _existing_speaker(e):
            continue
        if e.get('speaker_suggestion'):
            continue
        out.append(i)
    return out


def _character_lookup(ctx):
    """Build a {lower_en_or_ja_name: {en, ja}} map for resolving a guess
    back to the canonical bilingual character record."""
    table = {}
    for c in (ctx.get('characters') or []):
        if not isinstance(c, dict):
            continue
        name = c.get('name') or {}
        en = (name.get('en') if isinstance(name, dict) else (name or '')) or ''
        ja = (name.get('ja') if isinstance(name, dict) else '') or ''
        if en: table[en.strip().lower()] = {'en': en.strip(), 'ja': ja.strip()}
        if ja: table[ja.strip().lower()] = {'en': en.strip(), 'ja': ja.strip()}
    return table


def _format_record_for_guess(idx, e, include_speaker=True):
    """Compact format for the prompt: idx + time + JA + optional speaker."""
    ja = _ja_of(e)
    spk = _existing_speaker(e) if include_speaker else ''
    start = float(e.get('start') or 0)
    end   = float(e.get('end')   or start)
    block = [
        str(idx + 1),
        f"{_adv._to_srt_time(start)} --> {_adv._to_srt_time(end)}",
        f"[{ja}]",
    ]
    if spk:
        block.append(f"[SPEAKER: {spk}]")
    return '\n'.join(block)


def _build_static_block(ctx):
    """Project context + story-so-far for every chunk."""
    parts = []
    static = _adv._build_static_context(ctx)
    if static:
        parts.append("=== PROJECT CONTEXT ===\n" + static)
    story = (ctx.get('story_so_far') or '').strip()
    if story:
        parts.append("=== STORY SO FAR ===\n" + story)
    return '\n\n'.join(parts)


def _scenes_for_chunk(scenes, chunk_records):
    """Return the scene dicts that overlap any record in this chunk."""
    if not scenes:
        return []
    overlapping = []
    seen = set()
    for r in chunk_records:
        t_start = float(r.get('start') or 0)
        t_end   = float(r.get('end')   or t_start)
        for i, s in enumerate(scenes):
            if not isinstance(s, dict):
                continue
            try:
                ss = float(s.get('start') or 0)
                se = float(s.get('end')   or ss)
            except (TypeError, ValueError):
                continue
            if t_start < se and t_end > ss and i not in seen:
                seen.add(i)
                overlapping.append((i, s))
    return overlapping


def _established_speakers_nearby(subs, chunk, window=8):
    """Walk a wider window of records (±N) around the chunk and collect the
    set of distinct speakers actually seen. These are the prime candidates
    for the chunk's speakers — the model should bias heavily toward them."""
    earliest = chunk[0]; latest = chunk[-1]
    target_set = set(chunk)
    seen = []
    seen_lower = set()
    for j in range(max(0, earliest - window), min(len(subs), latest + window + 1)):
        if j in target_set:
            continue
        spk = _existing_speaker(subs[j])
        if not spk:
            continue
        key = spk.lower()
        if key in seen_lower:
            continue
        seen_lower.add(key)
        seen.append(spk)
    return seen


def _build_chunk_user_message(ctx, subs, chunk):
    """Static context + ACTIVE SCENE description + RECENTLY SEEN SPEAKERS +
    a window of context records (3 each side, with their speaker assignments
    visible) + the AUDIT chunk (the records we want guesses for).

    The active-scene + recently-seen sections give the model the resolved
    answer to "which characters are likely in this part of the story" so it
    doesn't have to compute that itself from the global scenes table."""
    parts = []
    static = _build_static_block(ctx)
    if static:
        parts.append(static)

    chunk_records = [subs[i] for i in chunk if 0 <= i < len(subs)]

    # ── Active scene(s) ─────────────────────────────────────────────────
    scenes = ctx.get('scenes') or []
    active_scenes = _scenes_for_chunk(scenes, chunk_records)
    if active_scenes:
        scene_lines = ["=== ACTIVE SCENE(S) for this chunk ==="]
        for i, s in active_scenes:
            try:
                ss = float(s.get('start') or 0)
                se = float(s.get('end')   or ss)
                hdr = f"Scene {i+1} ({_adv._to_srt_time(ss)}–{_adv._to_srt_time(se)}):"
            except (TypeError, ValueError):
                hdr = f"Scene {i+1}:"
            txt = (s.get('text') or '').strip() or '(no description)'
            scene_lines.append(f"{hdr} {txt}")
        parts.append('\n'.join(scene_lines))

    # ── Established speakers nearby ─────────────────────────────────────
    nearby = _established_speakers_nearby(subs, chunk, window=8)
    if nearby:
        parts.append(
            "=== RECENTLY SEEN SPEAKERS (within ±8 records of this chunk) ===\n"
            "These characters are confirmed to be active right now. The chunk's "
            "speakers are most likely from this set:\n"
            + '\n'.join('  • ' + n for n in nearby)
        )

    # ── Close-context (per-record window with [SPEAKER:] hints) ─────────
    earliest = chunk[0]; latest = chunk[-1]
    target_set = set(chunk)
    ctx_lines = []
    for j in range(max(0, earliest - 3), earliest):
        if j in target_set: continue
        ctx_lines.append(_format_record_for_guess(j, subs[j], include_speaker=True))
    for j in range(latest + 1, min(len(subs), latest + 4)):
        if j in target_set: continue
        ctx_lines.append(_format_record_for_guess(j, subs[j], include_speaker=True))
    if ctx_lines:
        parts.append("=== [CONTEXT — speakers shown for reference, do not re-guess] ===\n"
                     + '\n\n'.join(ctx_lines))

    audit_lines = ["=== AUDIT — guess the speaker for each ==="]
    for i in chunk:
        audit_lines.append(_format_record_for_guess(i, subs[i], include_speaker=False))
    parts.append('\n\n'.join(audit_lines))
    return '\n\n'.join(parts)


# ── Response parsing ─────────────────────────────────────────────────────────

# "<idx>: <Name>" header line
_HEADER_RE = re.compile(r'^\s*(\d+)\s*[:：]\s*(.+?)\s*$')
_NOTE_RE   = re.compile(r'^\*Note:\s*(.+?)\*?\s*$', re.IGNORECASE)
_CONF_RE   = re.compile(r'\b(high|medium|low)\b', re.IGNORECASE)


def _parse_response(response, expected_indices, char_table):
    """Walk the model's output. For each expected index, return either:
      {'name': {'en','ja'}, 'confidence': str, 'note': str}  — confident
      {'name': None, 'confidence': '', 'note': str}           — '?' (no guess)
    Records the model omitted are simply absent from the result."""
    out = {}
    expected = set(int(i) + 1 for i in expected_indices)
    blocks = re.split(r'\n\s*\n', (response or '').strip())
    for blk in blocks:
        lines = [l.rstrip() for l in blk.splitlines() if l.strip()]
        if not lines:
            continue
        m = _HEADER_RE.match(lines[0])
        if not m:
            continue
        try: idx_one = int(m.group(1))
        except ValueError: continue
        if idx_one not in expected:
            continue
        name_raw = m.group(2).strip()
        # Strip trailing parenthesised confidence if the model put it inline
        name_raw = re.sub(r'\s*\([^)]*\)\s*$', '', name_raw).strip()
        note = ''
        for l in lines[1:]:
            mn = _NOTE_RE.match(l)
            if mn:
                note = mn.group(1).strip()
                break
        confidence = ''
        cm = _CONF_RE.search(note)
        if cm:
            confidence = cm.group(1).lower()

        if name_raw in ('?', '？', '???', '???', ''):
            out[idx_one - 1] = {'name': None, 'confidence': confidence, 'note': note}
            continue
        # Resolve to canonical {en, ja} via the lookup table
        canonical = char_table.get(name_raw.lower())
        if not canonical:
            # Try a fuzzier match — the model may have appended romaji
            for key, val in char_table.items():
                if key and key in name_raw.lower():
                    canonical = val; break
        if not canonical:
            # Unknown name — store as best-effort EN-only so the user can
            # still see what the model said (won't apply cleanly to the
            # speaker pills though).
            canonical = {'en': name_raw, 'ja': ''}
        out[idx_one - 1] = {
            'name': canonical, 'confidence': confidence or 'low', 'note': note,
        }
    return out


# ── Public batch runner ──────────────────────────────────────────────────────

def guess_speakers(project_path, options, on_step=None, on_progress=None):
    """Walk unassigned records in chunks, ask Qwen for guesses, write each
    result onto entries[i].speaker_suggestion. Streams progress events."""
    def step(msg):
        log.info(f'[speaker-guess] {msg}')
        if on_step:
            on_step(msg)

    if not os.path.exists(project_path):
        raise FileNotFoundError(project_path)
    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)
    subs = project.get('subtitles') or []
    ctx  = project.get('context') or {}

    chunk_size = max(1, int((options or {}).get('chunk_size') or 15))
    redo = bool((options or {}).get('redo'))   # if true, also re-process records that already have a suggestion

    char_table = _character_lookup(ctx)
    if not char_table:
        raise RuntimeError('project has no characters defined — add some on the Context tab first')

    # Build target list
    targets = []
    for i, e in enumerate(subs):
        if not isinstance(e, dict): continue
        if not _is_transcribed(_ja_of(e)): continue
        if _existing_speaker(e): continue
        if e.get('speaker_suggestion') and not redo: continue
        targets.append(i)
    if not targets:
        step('Nothing to guess — every transcribed record either has a speaker or a pending suggestion.')
        return {'reviewed': 0, 'suggested': 0, 'skipped': 0, 'chunks': 0}

    step(f'Guessing speakers for {len(targets)} record(s) in chunks of {chunk_size}…')

    # Make sure Qwen is loaded before the first chunk. Without this, the
    # first call to _adv._generate hits NoneType on _adv._tokenizer.
    _adv._ensure_loaded(on_step=on_step)

    total_chunks = (len(targets) + chunk_size - 1) // chunk_size
    suggested = 0
    skipped   = 0
    reviewed  = 0

    for ci in range(1, total_chunks + 1):
        chunk = targets[(ci - 1) * chunk_size : ci * chunk_size]
        if not chunk:
            continue
        step(f'── Chunk {ci}/{total_chunks} — records {chunk[0] + 1}–{chunk[-1] + 1} ──')

        # Defensive re-load — another request may have unloaded Qwen
        # between chunks. Cheap when already warm.
        if not _adv.is_loaded():
            step('  ⟳ Qwen was unloaded — reloading…')
            _adv._ensure_loaded(on_step=on_step)

        user_msg = _build_chunk_user_message(ctx, subs, chunk)
        messages = [
            {'role': 'system', 'content': SYSTEM_PROMPT},
            {'role': 'user',   'content': user_msg},
        ]

        try:
            response = _adv._with_heartbeat(
                f'Guessing chunk {ci}/{total_chunks}', on_step,
                lambda: _adv._generate(messages, max_new_tokens=2048, temperature=0.2),
            )
        except Exception as ex:
            step(f'  ✗ Chunk {ci} failed: {ex}')
            continue

        parsed = _parse_response(response, chunk, char_table)
        reviewed += len(chunk)

        for idx in chunk:
            got = parsed.get(idx)
            e = subs[idx]
            if not got or got.get('name') is None:
                # No confident guess — record a placeholder so the UI can show
                # "model wasn't sure" rather than nothing.
                if got and (got.get('note') or got.get('confidence')):
                    e['speaker_suggestion'] = {
                        'en': '', 'ja': '',
                        'confidence': got.get('confidence') or 'low',
                        'note': got.get('note') or '(no confident guess)',
                    }
                    skipped += 1
                    step(f'  ? {idx + 1}: no confident guess')
                    if on_progress:
                        on_progress({
                            'idx': idx, 'name_en': '', 'name_ja': '',
                            'confidence': e['speaker_suggestion']['confidence'],
                            'note': e['speaker_suggestion']['note'],
                        })
                continue
            name = got['name']
            e['speaker_suggestion'] = {
                'en': name.get('en') or '',
                'ja': name.get('ja') or '',
                'confidence': got.get('confidence') or 'low',
                'note': got.get('note') or '',
            }
            suggested += 1
            step(f'  💡 {idx + 1}: {name.get("en") or name.get("ja")} ({got.get("confidence")})')
            if on_progress:
                on_progress({
                    'idx': idx,
                    'name_en': name.get('en') or '',
                    'name_ja': name.get('ja') or '',
                    'confidence': got.get('confidence') or 'low',
                    'note': got.get('note') or '',
                })

        # Persist after every chunk so a crash mid-run doesn't lose progress.
        try:
            with open(project_path, 'w', encoding='utf-8') as f:
                json.dump(project, f, indent=2, ensure_ascii=False)
        except Exception as ex:
            log.warning(f'mid-job save failed: {ex}')

    step(f'✓ {suggested} suggestion(s) · {skipped} unsure · {reviewed} reviewed')
    return {'reviewed': reviewed, 'suggested': suggested, 'skipped': skipped, 'chunks': total_chunks}


# ── Apply / dismiss ──────────────────────────────────────────────────────────

def apply_suggestion(project_path, idx, override=None):
    """Move entries[idx].speaker_suggestion into entries[idx].speaker.

    If `override` is provided ({'en': str, 'ja': str}), use that instead of
    the suggestion's stored name — lets the UI's character dropdown correct
    the AI's guess at apply time.

    Skips when neither the override nor the suggestion has a name. Returns
    True if a real assignment landed."""
    if not os.path.exists(project_path):
        raise FileNotFoundError(project_path)
    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)
    subs = project.get('subtitles') or []
    if not (0 <= idx < len(subs)):
        return False
    e = subs[idx]
    if not isinstance(e, dict):
        return False

    if override and (override.get('en') or override.get('ja')):
        name_en = (override.get('en') or '').strip()
        name_ja = (override.get('ja') or '').strip()
    else:
        sug = e.get('speaker_suggestion') or {}
        name_en = (sug.get('en') or '').strip()
        name_ja = (sug.get('ja') or '').strip()

    if not name_en and not name_ja:
        # '?' suggestion + no override — just drop the suggestion
        e.pop('speaker_suggestion', None)
        with open(project_path, 'w', encoding='utf-8') as f:
            json.dump(project, f, indent=2, ensure_ascii=False)
        return False
    e['speaker'] = {'en': name_en, 'ja': name_ja}
    e.pop('speaker_suggestion', None)
    with open(project_path, 'w', encoding='utf-8') as f:
        json.dump(project, f, indent=2, ensure_ascii=False)
    return True


def dismiss_suggestion(project_path, idx):
    """Drop entries[idx].speaker_suggestion without applying it."""
    if not os.path.exists(project_path):
        raise FileNotFoundError(project_path)
    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)
    subs = project.get('subtitles') or []
    if not (0 <= idx < len(subs)):
        return False
    e = subs[idx]
    if not isinstance(e, dict):
        return False
    if e.pop('speaker_suggestion', None) is None:
        return False
    with open(project_path, 'w', encoding='utf-8') as f:
        json.dump(project, f, indent=2, ensure_ascii=False)
    return True


def clear_all_suggestions(project_path):
    """Drop every speaker_suggestion (used by the Clear All button)."""
    if not os.path.exists(project_path):
        raise FileNotFoundError(project_path)
    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)
    subs = project.get('subtitles') or []
    cleared = 0
    for e in subs:
        if isinstance(e, dict) and e.pop('speaker_suggestion', None) is not None:
            cleared += 1
    with open(project_path, 'w', encoding='utf-8') as f:
        json.dump(project, f, indent=2, ensure_ascii=False)
    return cleared
