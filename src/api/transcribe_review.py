"""
Transcribblr — Conversational + bulk review of TRANSCRIPTIONS (Japanese)
Mirrors translate_advanced's review/full-review flow but operates on
text.ja instead of text.en + text.lit. Reuses the Qwen2.5-14B model and
prompt-construction helpers from translate_advanced.

Output format the model is asked to produce per record block:
   <idx>
   <srt-time>
   [corrected Japanese]
   *Note: high|medium|low confidence — what was wrong and what changed*
"""

import os
import re
import json

import config
from logger import log
import translate_advanced as _adv


# ── System prompts ───────────────────────────────────────────────────────────

REVIEW_SYSTEM_PROMPT = (
    "You are a professional Japanese transcription reviewer working on an "
    "anime production. Your job is to spot likely errors in machine-generated "
    "Japanese subtitle transcriptions and suggest corrections. The audio was "
    "transcribed by Whisper; common mistakes include homophone confusion, "
    "particle errors, missing words, and grammatically nonsensical phrases.\n\n"
    "When the editor shares records, look for:\n"
    "- Phrases that don't make grammatical sense in Japanese\n"
    "- Likely homophone confusion (e.g. 下がっている vs 話している)\n"
    "- Words that don't match the scene context or the assigned speaker\n"
    "- Missing or duplicated content\n"
    "- Obviously broken particles or verb conjugations\n\n"
    "RECORD FORMAT (when you propose a correction, exactly):\n"
    "<idx>\n"
    "<srt-time>\n"
    "[corrected Japanese]\n"
    "*Note: high|medium|low confidence — what was wrong, what you changed, why*\n\n"
    "RULES:\n"
    "- Only the bracketed [Japanese] line goes inside record blocks. Do NOT "
    "include romaji, English, or literal translation lines.\n"
    "- Always include a *Note* line when you produce a record block.\n"
    "- Be conservative — don't 'correct' lines that are merely stylistically odd. "
    "Only flag genuine errors.\n"
    "- Records that look correct should NOT appear in record format. Just "
    "discuss them in plain prose if relevant.\n"
    "- [SPEAKER: …] in editor messages is metadata only; never include speaker "
    "names in your output.\n"
    "- When the editor asks a question or wants discussion, answer naturally "
    "without record blocks.\n"
)

FULL_AUDIT_SYSTEM_PROMPT = (
    "You are a Japanese ASR (automatic speech recognition) error reviewer. "
    "Whisper transcribed the audio and may have made HOMOPHONE / MISHEARD "
    "errors — words that sound similar but mean different things. Your "
    "ONLY job is to spot those specific errors and propose minimal fixes.\n\n"
    "WHAT YOU MAY FIX:\n"
    "- Homophone confusion (eg 下がっている → 話している, 猿 → 去る)\n"
    "- Words misheard as similar-sounding ones\n"
    "- Particles that obviously break grammar (eg を vs は in a fixed verb pattern)\n"
    "- Verb conjugations that don't match the surrounding form\n\n"
    "WHAT YOU MUST NEVER DO:\n"
    "- Do NOT add words that aren't in the original.\n"
    "- Do NOT remove words from the original.\n"
    "- Do NOT change the speaker's tone, register, or politeness level.\n"
    "- Do NOT restructure sentences. The corrected line should differ from "
    "the original ONLY in the specific characters that were misheard.\n"
    "- Do NOT 'improve' grammar that's intentionally informal/colloquial — "
    "anime dialogue is often slangy and that's correct.\n"
    "- Do NOT change something just because it sounds odd in context. "
    "Only change it if you can name the specific homophone or particle "
    "swap that explains the error.\n\n"
    "DECISION FOR EACH RECORD:\n"
    "- If the Japanese contains no clear ASR error, output ONE LINE: `<idx> OK`\n"
    "- If you can identify a specific homophone/mishearing error, output:\n"
    "    <idx>\n"
    "    <srt-time>\n"
    "    [corrected Japanese — same length and structure, with only the misheard tokens swapped]\n"
    "    *Note: high|medium|low confidence — name the specific token(s) you swapped and the homophone they likely came from*\n\n"
    "EXAMPLES:\n\n"
    "Good fix (homophone):\n"
    "Input:  [人間が言葉を下がっている。]\n"
    "Output:\n"
    "12\n"
    "00:01:00,000 --> 00:01:02,000\n"
    "[人間が言葉を話している。]\n"
    "*Note: high confidence — swapped 下がっている → 話している (homophone). 下がっている (sagatte iru, 'descending') makes no grammatical sense after 言葉を; 話している (hanashite iru, 'speaking') is the obvious intended verb.*\n\n"
    "Bad fix (rewrite — DO NOT DO THIS):\n"
    "Input:  [聞いたかよ。猿だってよ。]\n"
    "Bad output: [聞いたじゃない。人間じゃないってよ。]   ← REJECTED. You added words, changed the speaker register, and replaced 猿 with 人間 without justification. If 猿 was misheard, name the homophone it came from. Otherwise output `<idx> OK`.\n"
    "Correct output for this input: <idx> OK\n\n"
    "CRITICAL RULES:\n"
    "- Every record block MUST include a *Note* line explaining the specific swap. No note → no fix.\n"
    "- Most lines should be `OK`. If you're flagging more than ~20% of a chunk, you're being too aggressive.\n"
    "- NEVER produce a record block with the same Japanese as the input — output `<idx> OK` instead.\n"
    "- Separate records with blank lines.\n"
    "- Do NOT include romaji, English, or literal lines anywhere.\n"
    "- Cover EVERY record in the chunk — either `<idx> OK` or a full block.\n"
)


# ── Public chat runner (used by the Review sub-tab) ──────────────────────────

def chat(messages, on_step=None):
    """Run one chat round through Qwen with the transcription-review system
    prompt. Mirrors translate_advanced.chat() but injects our own system
    prompt when the supplied history doesn't include one."""
    msgs = list(messages or [])
    if not any(m.get('role') == 'system' for m in msgs):
        msgs = [{'role': 'system', 'content': REVIEW_SYSTEM_PROMPT}] + msgs
    return _adv.chat(msgs, on_step=on_step)


# ── Baseline + attach helpers (mirror translate_advanced) ────────────────────

def _format_transcribe_record_block(idx, e):
    """Format one record for the prompt — JA only, plus speaker hint."""
    ja = (e.get('text', {}).get('ja') if isinstance(e.get('text'), dict)
          else (e.get('text') or '')) or ''
    spk = ''
    speaker = e.get('speaker') if isinstance(e, dict) else None
    if isinstance(speaker, dict):
        spk = (speaker.get('en') or speaker.get('ja') or '').strip()
    elif isinstance(speaker, str):
        spk = speaker.strip()
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


def _ja_of(entry):
    text = entry.get('text') if isinstance(entry, dict) else None
    if isinstance(text, dict):
        return (text.get('ja') or '').strip()
    if isinstance(text, str):
        return text.strip()
    return ''


def _is_transcribed(ja):
    """Has real Japanese content (not the ???? placeholder)."""
    return bool(ja) and '????' not in ja


def build_review_baseline_message(project_path, indices, user_text='',
                                   context_mode='tldr'):
    """First user message of a transcription review: project context +
    surrounding records + the records under review (JA only) + the user's
    typed message. context_mode mirrors translate_advanced."""
    if not os.path.exists(project_path):
        raise FileNotFoundError(project_path)
    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)
    subs = project.get('subtitles') or []
    ctx  = project.get('context') or {}
    mode = (context_mode or 'tldr').lower()
    if mode not in ('close', 'tldr', 'full'):
        mode = 'tldr'

    parts = []
    static = _adv._build_static_context(ctx)
    if static:
        parts.append("=== PROJECT CONTEXT ===\n" + static)

    earliest = min(indices) if indices else len(subs)
    latest   = max(indices) if indices else -1

    if mode == 'tldr':
        story = (ctx.get('story_so_far') or '').strip()
        if story:
            parts.append("=== STORY SO FAR ===\n" + story)
        after = (ctx.get('story_after') or '').strip()
        if after:
            parts.append("=== WHAT HAPPENS AFTER (forward context) ===\n" + after)
    elif mode == 'full':
        # All transcribed records before / after the focus, JA only.
        before_lines = []
        for i in range(earliest):
            ja = _ja_of(subs[i])
            if not _is_transcribed(ja):
                continue
            before_lines.append(f"{i+1}: [{ja}]")
        if before_lines:
            parts.append("=== PRIOR TRANSCRIBED LINES ===\n" + '\n'.join(before_lines))
        after_lines = []
        for i in range(latest + 1, len(subs)):
            ja = _ja_of(subs[i])
            if not _is_transcribed(ja):
                continue
            after_lines.append(f"{i+1}: [{ja}]")
        if after_lines:
            parts.append("=== FORWARD TRANSCRIBED LINES ===\n" + '\n'.join(after_lines))

    # Close context: 3 records before earliest + 3 after latest
    if indices:
        target_set = set(indices)
        close_lines = []
        for j in range(max(0, earliest - 3), earliest):
            if j in target_set: continue
            close_lines.append(_format_transcribe_record_block(j, subs[j]))
        for j in range(latest + 1, min(len(subs), latest + 4)):
            if j in target_set: continue
            close_lines.append(_format_transcribe_record_block(j, subs[j]))
        if close_lines:
            parts.append("=== [CLOSE CONTEXT — do not revise, for flow only] ===\n"
                         + '\n\n'.join(close_lines))

    if indices:
        rec_blocks = ["=== TRANSCRIPTIONS UNDER REVIEW ==="]
        for i in indices:
            if 0 <= i < len(subs):
                rec_blocks.append(_format_transcribe_record_block(i, subs[i]))
        parts.append('\n\n'.join(rec_blocks))

    if user_text and user_text.strip():
        parts.append(user_text.strip())
    else:
        parts.append("Please review the transcriptions above. Flag anything "
                     "that looks like a transcription error and suggest a "
                     "correction. Confirm the rest are fine.")
    return '\n\n'.join(parts)


def build_attach_records_block(project_path, indices):
    """Mid-chat attachment — just the record blocks (JA + speaker)."""
    if not indices:
        return ''
    if not os.path.exists(project_path):
        raise FileNotFoundError(project_path)
    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)
    subs = project.get('subtitles') or []
    rec_blocks = ["=== ADDITIONAL RECORDS ==="]
    for i in indices:
        if 0 <= i < len(subs):
            rec_blocks.append(_format_transcribe_record_block(i, subs[i]))
    return '\n\n'.join(rec_blocks)


# ── Response parsing ─────────────────────────────────────────────────────────

_NOTE_RE = re.compile(r'^\*Note:\s*(.+?)\*?\s*$', re.IGNORECASE)


def _parse_response(response, expected_indices):
    """Walk a chat response and pick out one block per expected index.
    Returns {idx: {'ja': str, 'note': str|None, 'block_text': str}}."""
    out = {}
    blocks = re.split(r'\n\s*\n', (response or '').strip())
    expected = set(int(i) + 1 for i in expected_indices)
    for blk in blocks:
        lines = [l.rstrip() for l in blk.splitlines() if l.strip()]
        if not lines:
            continue
        try:
            idx_one = int(lines[0].strip())
        except ValueError:
            continue
        if idx_one not in expected:
            continue
        ja = ''
        note = None
        for l in lines[1:]:
            if _NOTE_RE.match(l):
                note = _NOTE_RE.match(l).group(1).strip()
                break
            if '-->' in l:
                continue
            if l.startswith('[') and l.endswith(']'):
                ja = l[1:-1].strip()
                continue
            # Skip stray speaker echoes / romaji / EN lines
            if re.match(r'^\s*\[?\s*speaker\s*[:：]', l, re.IGNORECASE):
                continue
            if l.startswith('(') and l.endswith(')'):
                continue
            if l.startswith('<') and l.endswith('>'):
                continue
        if ja:
            out[idx_one - 1] = {'ja': ja, 'note': note, 'block_text': blk}
    return out


def _parse_full_audit_response(response, expected_indices):
    """Walk a full-audit response. Records appearing as '<idx> OK' lines are
    silently skipped. Records with full blocks return their parsed correction.
    Returns {idx: {'ja','note','block_text'}}."""
    out = {}
    expected = set(int(i) + 1 for i in expected_indices)
    text = (response or '').strip()

    # First, drop OK lines from consideration so re.split blocks works cleanly.
    ok_re = re.compile(r'^\s*(\d+)\s+OK\s*$', re.MULTILINE | re.IGNORECASE)
    text_no_ok = ok_re.sub('', text)

    blocks = re.split(r'\n\s*\n', text_no_ok.strip())
    for blk in blocks:
        lines = [l.rstrip() for l in blk.splitlines() if l.strip()]
        if not lines:
            continue
        try:
            idx_one = int(lines[0].strip())
        except ValueError:
            continue
        if idx_one not in expected:
            continue
        ja = ''
        note = None
        for l in lines[1:]:
            if _NOTE_RE.match(l):
                note = _NOTE_RE.match(l).group(1).strip()
                break
            if '-->' in l:
                continue
            if l.startswith('[') and l.endswith(']'):
                ja = l[1:-1].strip()
                continue
        if ja:
            out[idx_one - 1] = {'ja': ja, 'note': note, 'block_text': blk}
    return out


# ── Apply ────────────────────────────────────────────────────────────────────

def _apply_ja_correction(e, new_ja):
    """Mutate one entry in place after a JA correction is accepted.
    - Writes the new JA
    - Wipes EN + literal + translator_note (they referenced the old JA)
    - Regenerates romaji inline via cutlet (no need to wait for lazy
      browser-side regen; downstream consumers see fresh ro right away)
    - Sets entry.new = true so the 🆕 review marker appears

    Returns True if anything actually changed.
    """
    if not isinstance(e.get('text'), dict):
        e['text'] = {'ja': '', 'ro': '', 'en': ''}
    if e['text'].get('ja') == new_ja:
        return False
    e['text']['ja'] = new_ja

    # Translation no longer matches the source — drop both lanes + the
    # translator note. The user can re-translate from the Translations tab
    # once they're happy with the new JA.
    e['text']['en']  = ''
    e['text']['lit'] = ''
    e.pop('translator_note', None)

    # Romaji recalculation. Try cutlet via the romaji module — fast and
    # synchronous. If it's unavailable for any reason, fall back to clearing
    # the cached value so the frontend's lazy /romaji call regenerates it.
    try:
        import romaji as _romaji
        e['text']['ro'] = _romaji.convert(new_ja) or ''
    except Exception:
        e['text']['ro'] = ''

    e['new'] = True
    return True


def apply_response(project_path, response_text, indices):
    """Parse a chat response and apply any per-record corrections to the
    project JSON. Wipes EN + literal + translator_note, regenerates romaji,
    sets entry.new = true. Returns count updated."""
    if not os.path.exists(project_path):
        raise FileNotFoundError(project_path)
    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)
    subs = project.get('subtitles') or []

    parsed = _parse_response(response_text, indices)
    updated = 0
    for idx, got in parsed.items():
        if not (0 <= idx < len(subs)):
            continue
        if _apply_ja_correction(subs[idx], got['ja']):
            updated += 1
    if updated:
        with open(project_path, 'w', encoding='utf-8') as f:
            json.dump(project, f, indent=2, ensure_ascii=False)
    return updated


# ── Bulk audit (Full Review for transcriptions) ──────────────────────────────

def full_audit_project(project_path, options, on_step=None, on_progress=None):
    """Walk the project's transcribed records in chunks, ask Qwen which
    look broken, emit one suggestion-progress event per flagged record.
    Mirrors translate_advanced.full_review_project."""
    def step(msg):
        log.info(f'[transcribe-audit] {msg}')
        if on_step:
            on_step(msg)

    if not os.path.exists(project_path):
        raise FileNotFoundError(project_path)
    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)
    subs = project.get('subtitles') or []
    ctx  = project.get('context') or {}

    chunk_size = max(1, int((options or {}).get('chunk_size') or 10))
    scope      = ((options or {}).get('scope') or 'all').lower()

    # Targets: every transcribed record. If scope=='unreviewed', only those
    # NOT already 🆕-flagged or with translator notes (i.e. user hasn't
    # touched them yet). For now we'll just provide 'all'.
    targets = []
    for i, e in enumerate(subs):
        ja = _ja_of(e)
        if not _is_transcribed(ja):
            continue
        if scope == 'unreviewed' and (e.get('new') or e.get('translator_note')):
            continue
        targets.append(i)
    if not targets:
        step('Nothing to audit.')
        return {'reviewed': 0, 'suggested': 0, 'chunks': 0}

    step(f'Auditing {len(targets)} record(s) in chunks of {chunk_size}…')

    # Make sure Qwen is loaded before the first chunk. Without this, the
    # first call to _adv._generate hits NoneType on _adv._tokenizer.
    _adv._ensure_loaded(on_step=on_step)

    static = _adv._build_static_context(ctx)
    static_block = ("=== PROJECT CONTEXT ===\n" + static + "\n\n") if static else ''

    reviewed = 0
    suggested = 0
    chunks_done = 0
    total_chunks = (len(targets) + chunk_size - 1) // chunk_size

    for ci in range(1, total_chunks + 1):
        chunk = targets[(ci - 1) * chunk_size : ci * chunk_size]
        if not chunk:
            continue
        step(f'── Chunk {ci}/{total_chunks} — records {chunk[0] + 1}–{chunk[-1] + 1} ──')

        # Defensive re-load — another request (eg /context-edit, tab swap)
        # may have unloaded Qwen between chunks. Cheap when already warm.
        if not _adv.is_loaded():
            step('  ⟳ Qwen was unloaded — reloading…')
            _adv._ensure_loaded(on_step=on_step)

        rec_blocks = ["=== AUDIT THIS CHUNK ==="]
        for i in chunk:
            rec_blocks.append(_format_transcribe_record_block(i, subs[i]))
        user_msg = static_block + '\n\n'.join(rec_blocks)

        messages = [
            {'role': 'system', 'content': FULL_AUDIT_SYSTEM_PROMPT},
            {'role': 'user',   'content': user_msg},
        ]

        try:
            # temperature=0 → greedy decoding. Reduces the model's tendency
            # to "creatively" rewrite lines (the prompt forbids it but with
            # sampling on it sometimes happens anyway).
            response = _adv._with_heartbeat(
                f'Auditing chunk {ci}/{total_chunks}', on_step,
                lambda: _adv._generate(messages, max_new_tokens=2048, temperature=0.0),
            )
        except Exception as ex:
            step(f'  ✗ Chunk {ci} failed: {ex}')
            continue

        parsed = _parse_full_audit_response(response, chunk)
        reviewed += len(chunk)
        chunks_done += 1

        chunk_suggested = 0
        chunk_noops = 0
        chunk_no_note = 0
        for idx in chunk:
            if idx not in parsed:
                continue
            got = parsed[idx]
            e = subs[idx]
            cur_ja = _ja_of(e)
            proposed_ja = (got.get('ja') or '').strip()
            note        = (got.get('note') or '').strip()
            # Filter no-op "suggestions" — model sometimes echoes the input.
            if not proposed_ja or _ja_eq(cur_ja, proposed_ja):
                chunk_noops += 1
                continue
            # Reject suggestions with no *Note* — the prompt requires one,
            # and unjustified rewrites tend to be the "creative restructure"
            # cases the user is complaining about.
            if not note:
                chunk_no_note += 1
                step(f'  ⚠ {idx + 1}: dropped (no *Note* — unjustified change)')
                continue
            start = float(e.get('start') or 0)
            end   = float(e.get('end')   or start)
            payload = {
                'idx': idx,
                'time': f"{_adv._to_srt_time(start)} --> {_adv._to_srt_time(end)}",
                'current_ja':  cur_ja,
                'proposed_ja': proposed_ja,
                'note':        note,
                'block_text':  got.get('block_text') or '',
            }
            suggested += 1
            chunk_suggested += 1
            step(f'  💡 {idx + 1}: {proposed_ja[:60]}')
            if on_progress:
                on_progress(payload)
        extras = []
        if chunk_noops:   extras.append(f'{chunk_noops} no-op(s) filtered')
        if chunk_no_note: extras.append(f'{chunk_no_note} unjustified dropped')
        suffix = (' · ' + ', '.join(extras)) if extras else ''
        step(f'  ✓ Chunk {ci} done — {chunk_suggested} suggestion(s){suffix}')

    return {'reviewed': reviewed, 'suggested': suggested, 'chunks': chunks_done}


def _ja_eq(a, b):
    """Normalise-then-compare for Japanese strings — collapse whitespace
    and full/half-width punctuation differences so the model's stylistic
    re-typing of the same line counts as a no-op."""
    def norm(s):
        s = (s or '').strip()
        # Collapse runs of whitespace
        s = re.sub(r'\s+', '', s)
        # Common full ↔ half-width pairs the model sometimes swaps
        # (these are still "the same sentence" for our purposes)
        trans = str.maketrans({
            '!':'！', '?':'？', ',':'、', '.':'。', ':':'：', ';':'；',
            '(':'(', ')':')',
        })
        return s.translate(trans)
    return norm(a) == norm(b)


def apply_full_audit_suggestion(project_path, idx, new_ja):
    """Apply a single suggestion from the Full Review picker. Wipes EN +
    literal + translator_note, regenerates romaji. Returns True if the
    record was actually modified."""
    if not os.path.exists(project_path):
        raise FileNotFoundError(project_path)
    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)
    subs = project.get('subtitles') or []
    if not (0 <= idx < len(subs)):
        return False
    if not _apply_ja_correction(subs[idx], new_ja):
        return False
    with open(project_path, 'w', encoding='utf-8') as f:
        json.dump(project, f, indent=2, ensure_ascii=False)
    return True
