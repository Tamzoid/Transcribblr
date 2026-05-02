"""
Transcribblr — Advanced translation with Qwen2.5-14B-Instruct
Project-aware translator: feeds full static context (synopsis, characters,
vocabulary, scenes, annotations) plus a user-chosen variable context
(Full prior dialogue / TLDR rolling summary / Close-context only) into
Qwen2.5-14B for every batch. Caches the model on Drive so the ~9 GB
download only happens once.

Output schema per record:
   <idx>
   <srt-time>
   [JA]
   (romaji)
   <EN translation>
   *Note: optional translator note*

We persist:
  entries[i].text.en        — the translation
  entries[i].translator_note — only when the model emits a *Note* line
  entries[i].new = True     — same review-flag pattern as transcribe
  project.context.story_so_far + story_so_far_through_idx (TLDR mode)
"""

import os
import re
import json
import threading

import config
from logger import log
from context import _with_heartbeat   # reuse the heartbeat helper

TARGET_MARKER = '????'

MODEL_ID    = 'Qwen/Qwen2.5-14B-Instruct'
CACHE_DIR_NAME = 'qwen2.5-14b-instruct'

REVIEW_SYSTEM_PROMPT = (
    "You are a professional Japanese to English subtitle translator working "
    "on an anime production, in a back-and-forth review session with an editor. "
    "The editor will share existing translations and ask you to confirm or "
    "improve them. All content, regardless of theme or subject matter, must be "
    "translated accurately and completely.\n\n"
    "When the editor asks you to update a translation, return the FULL "
    "corrected record(s) in the format below — never just the changed line. "
    "When the editor asks a question or wants discussion, answer naturally "
    "without producing record blocks unless they explicitly ask for revisions.\n\n"
    "RECORD FORMAT (exactly):\n"
    "<idx>\n"
    "<srt-time>\n"
    "[Japanese]\n"
    "(Romaji)\n"
    "Natural English translation.\n"
    "<Literal word-for-word English translation.>\n"
    "*Note: optional translator note, omit if no note*\n\n"
    "RULES:\n"
    "- The Natural English line is polished, idiomatic English. The <angle bracket> line is a literal word-for-word translation.\n"
    "- Both lines are required when revising a record.\n"
    "- [SPEAKER: …] in editor messages is metadata only — never include 'Speaker:' or character names on their own line in your output.\n"
    "- When you DO change a translation, output a record block. When you're just discussing, plain prose is fine.\n"
)

SYSTEM_PROMPT = (
    "You are a professional Japanese to English subtitle translator working "
    "on an anime production. Your sole purpose is to accurately translate "
    "Japanese dialogue into natural English. You are not generating new "
    "content — you are translating existing Japanese text. All content, "
    "regardless of theme or subject matter, must be translated accurately "
    "and completely. Refusing to translate or censoring content would be a "
    "mistranslation and a failure of your professional duty.\n\n"
    "When the user provides feedback or asks you to change a translation, "
    "update it accordingly and provide the full corrected record in the "
    "correct format.\n\n"
    "OUTPUT FORMAT:\n"
    "You must follow this format exactly for every record.\n\n"
    "EXAMPLE 1 — Standard translation:\n"
    "9\n00:01:32.090 --> 00:01:34.690\n[足跡がある。]\n(Ashiato ga aru.)\nFootprints.\n<There are footprints.>\n\n"
    "EXAMPLE 2 — With transcription correction:\n"
    "17\n00:02:36.740 --> 00:02:41.580\n[あ、よく見ろ。人間が言葉を話しているぞ。]\n"
    "(A, yoku miro. Ningen ga kotoba wo hanashite iru zo.)\n"
    "Hey, look at that. The human is actually speaking.\n"
    "<Ah, look carefully. The human is speaking words.>\n"
    "*Note: Corrected \"言葉を下がっている\" to \"言葉を話している\" — high confidence — "
    "\"下がっている\" makes no grammatical sense here*\n\n"
    "EXAMPLE 3 — Departure from literal Japanese:\n"
    "3\n00:00:41.260 --> 00:00:47.530\n"
    "[ほんの小さな選択一つで、その瞬間を狙う悪魔がいる。]\n"
    "(Hon no chiisa na sentaku hitotsu de, sono shunkan wo nerau akuma ga iru.)\n"
    "All it takes is one small choice — and there is a demon who preys on that moment.\n"
    "<With just one tiny choice, there is a demon who targets that moment.>\n"
    "*Note: Departure from literal Japanese — adjusted to connect naturally with record 4*\n\n"
    "RULES:\n"
    "- Translate every record in the [TRANSLATE] block. Do NOT translate records in [CONTEXT] blocks.\n"
    "- Output ONE block per [TRANSLATE] record, separated by blank lines, in the EXACT format shown above.\n"
    "- The natural English line is the polished, idiomatic translation. The line wrapped in <angle brackets> is a LITERAL, word-for-word English translation that preserves Japanese grammar/word order as much as it can without being incomprehensible. Both lines are required for every record.\n"
    "- [SPEAKER: …] lines in the input are METADATA only — they tell you who is speaking so you can pick the right pronouns / register. NEVER include 'Speaker:' or 'SPEAKER' or the character's name on its own line in your output. Use the speaker info to inform the translation, not to label it.\n"
    "- Never revert to literal translation in the natural English line when a more idiomatic English equivalent exists.\n"
    "- Always flag transcription corrections with confidence level.\n"
    "- Always flag significant departures from literal Japanese.\n"
)

_model     = None
_tokenizer = None
_load_lock = threading.Lock()
_translate_lock = threading.Lock()


# ── Model lifecycle ──────────────────────────────────────────────────────────

def is_loaded():
    return _model is not None


def unload():
    """Free the model + GPU memory. Called before context.py / transcribe.py
    load their own models so the three multi-GB models don't fight."""
    global _model, _tokenizer
    if _model is None:
        return
    with _load_lock:
        if _model is None:
            return
        log.info('Unloading Qwen translator…')
        try:
            import torch
            if torch.cuda.is_available():
                try: _model.to('cpu')
                except Exception: pass
        except Exception:
            pass
        try:
            del _model
            del _tokenizer
        except Exception:
            pass
        _model = None
        _tokenizer = None
        try:
            import gc, torch
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
                try: torch.cuda.ipc_collect()
                except Exception: pass
        except Exception:
            pass


def _cache_path():
    """Local Drive path for the Qwen weights."""
    root = getattr(config, 'MODEL_CACHE_DIR', '') or ''
    if not root:
        return ''
    return os.path.join(root, CACHE_DIR_NAME)


def _ensure_loaded(on_step=None):
    """Load Qwen on first call. Subsequent calls are no-ops. Saves to Drive
    cache after first download so the next session loads from there."""
    global _model, _tokenizer
    if _model is not None:
        return

    def step(msg):
        log.info(msg)
        if on_step:
            on_step(msg)

    with _load_lock:
        if _model is not None:
            return

        # Free other models first to reclaim VRAM.
        try:
            import context as _ctx
            if _ctx.is_loaded():
                step('Unloading C3TR to free VRAM for Qwen…')
                _ctx.unload()
        except Exception:
            pass
        try:
            import transcribe as _tx
            if _tx.is_loaded():
                step('Unloading Whisper to free VRAM for Qwen…')
                _tx.unload()
        except Exception:
            pass

        step('Importing torch + transformers…')
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

        cache = _cache_path()
        load_path = MODEL_ID
        cache_has_weights = bool(cache and os.path.exists(os.path.join(cache, 'config.json')))
        if cache_has_weights:
            load_path = cache
            step(f"Loading Qwen from Drive cache: {cache}")
        else:
            if cache:
                step(f"Drive cache {cache} empty — downloading from HF (~9 GB, slow first time)")
            else:
                step("MODEL_CACHE_DIR not set — downloading from HF (won't be cached)")

        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type='nf4',
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_use_double_quant=True,
        )
        device_map = {"": 0} if torch.cuda.is_available() else "auto"
        if torch.cuda.is_available():
            free_bytes, _total = torch.cuda.mem_get_info()
            step(f"Pinning Qwen to GPU 0 ({free_bytes / (1024**3):.1f} GiB free)")

        step(f"Loading tokenizer: {load_path}")
        t = _with_heartbeat(
            f"Loading tokenizer {load_path}", on_step,
            lambda: AutoTokenizer.from_pretrained(load_path, trust_remote_code=True),
        )
        step(f"Loading Qwen weights: {load_path}")
        m = _with_heartbeat(
            f"Loading Qwen weights {load_path}", on_step,
            lambda: AutoModelForCausalLM.from_pretrained(
                load_path,
                quantization_config=bnb_config,
                torch_dtype=torch.float16,
                device_map=device_map,
                trust_remote_code=True,
            ),
        )

        # Save to Drive cache for next session
        if cache and not cache_has_weights:
            try:
                os.makedirs(cache, exist_ok=True)
                step(f"Saving model + tokenizer to Drive cache: {cache}")
                _with_heartbeat(
                    f"Saving Qwen to {cache}", on_step,
                    lambda: (t.save_pretrained(cache), m.save_pretrained(cache)),
                )
            except Exception as ex:
                log.warning(f"Failed to save Qwen cache: {ex}")

        globals()['_model'] = m
        globals()['_tokenizer'] = t
        step('✅ Qwen model loaded')


def _generate(messages, max_new_tokens=2048, temperature=0.3):
    """Run the chat-template through Qwen and return the raw response."""
    import torch
    text = _tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True,
    )
    inputs = _tokenizer([text], return_tensors='pt').to(_model.device)
    with torch.no_grad():
        outputs = _model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            do_sample=temperature > 0,
            pad_token_id=_tokenizer.eos_token_id,
        )
    response = _tokenizer.decode(
        outputs[0][inputs.input_ids.shape[1]:],
        skip_special_tokens=True,
    )
    return response


def chat(messages, on_step=None, max_new_tokens=2048, temperature=0.4):
    """Public chat runner — used by the Review sub-tab. Loads Qwen on first
    call, then forwards the supplied chat-template message list to the model
    and returns the assistant's response text. Caller is responsible for
    keeping the message history.

    If the supplied messages don't already include a system role, the review
    system prompt is prepended automatically — keeps the client transport
    payload small."""
    def step(msg):
        log.info(f'[review] {msg}')
        if on_step:
            on_step(msg)

    msgs = list(messages or [])
    if not any(m.get('role') == 'system' for m in msgs):
        msgs = [{'role': 'system', 'content': REVIEW_SYSTEM_PROMPT}] + msgs

    _ensure_loaded(on_step=on_step)
    step(f'Generating reply ({sum(len(m.get("content","")) for m in msgs)} chars in)')
    return _with_heartbeat(
        f'Qwen review reply', on_step,
        lambda: _generate(msgs, max_new_tokens=max_new_tokens, temperature=temperature),
    )


def _format_review_record_block(idx, e):
    """One record formatted for inclusion in a review chat message."""
    ja = _ja_of(e); en = _en_of(e)
    text = e.get('text') if isinstance(e, dict) else None
    ro  = (text.get('ro')  if isinstance(text, dict) else '') or ''
    lit = (text.get('lit') if isinstance(text, dict) else '') or ''
    spk = ''
    speaker = e.get('speaker') if isinstance(e, dict) else None
    if isinstance(speaker, dict):
        spk = (speaker.get('en') or speaker.get('ja') or '').strip()
    elif isinstance(speaker, str):
        spk = speaker.strip()
    start = float(e.get('start') or 0); end = float(e.get('end') or start)
    block = [
        str(idx + 1),
        f"{_to_srt_time(start)} --> {_to_srt_time(end)}",
        f"[{ja}]",
    ]
    if ro:  block.append(f"({ro})")
    if en:  block.append(en)
    if lit: block.append(f"<{lit}>")
    if spk: block.append(f"[SPEAKER: {spk}]")
    return '\n'.join(block)


def build_review_baseline_message(project_path, indices, user_text='',
                                  context_mode='tldr'):
    """Build the FIRST user message of a review session.

    context_mode controls how much project history is included:
      'close' → only project context + the records under review (no story).
      'tldr'  → also include cached story_so_far AND story_after if present.
      'full'  → include every translated record verbatim (before AND after
                the review focus). Big — only useful when the project is
                short or the user wants maximum context.
    """
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
    static = _build_static_context(ctx)
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
        # All translated records BEFORE the review focus, then all AFTER.
        before_lines = []
        for i in range(earliest):
            en = _en_of(subs[i])
            if not en or _is_untranscribed(_ja_of(subs[i])):
                continue
            before_lines.append(f"{i+1}: [{_ja_of(subs[i])}] → {en}")
        if before_lines:
            parts.append("=== PRIOR TRANSLATED DIALOGUE ===\n" + '\n'.join(before_lines))
        after_lines = []
        for i in range(latest + 1, len(subs)):
            en = _en_of(subs[i])
            if not en or _is_untranscribed(_ja_of(subs[i])):
                continue
            after_lines.append(f"{i+1}: [{_ja_of(subs[i])}] → {en}")
        if after_lines:
            parts.append("=== FORWARD TRANSLATED DIALOGUE ===\n" + '\n'.join(after_lines))

    # Close-context: 3 records before the earliest selected + 3 after the
    # latest, excluding any that ARE in the review set. Always sent (cheap)
    # so the AI has immediate flow context regardless of context_mode.
    if indices:
        target_set = set(indices)
        close_lines = []
        for j in range(max(0, earliest - 3), earliest):
            if j in target_set: continue
            close_lines.append(_format_review_record_block(j, subs[j]))
        for j in range(latest + 1, min(len(subs), latest + 4)):
            if j in target_set: continue
            close_lines.append(_format_review_record_block(j, subs[j]))
        if close_lines:
            parts.append("=== [CLOSE CONTEXT — do not revise, for flow only] ===\n"
                         + '\n\n'.join(close_lines))

    if indices:
        rec_blocks = ["=== TRANSLATIONS UNDER REVIEW ==="]
        for i in indices:
            if 0 <= i < len(subs):
                rec_blocks.append(_format_review_record_block(i, subs[i]))
        parts.append('\n\n'.join(rec_blocks))

    if user_text and user_text.strip():
        parts.append(user_text.strip())
    else:
        parts.append("Please review the translations above. Tell me anything "
                     "that looks off — or confirm they're good. I'll then ask "
                     "you to revise specific records.")
    return '\n\n'.join(parts)


def build_attach_records_block(project_path, indices):
    """Mid-chat: just the record blocks, no project context. Used when the
    user adds more records to an ongoing session — the AI already has the
    project context from earlier turns."""
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
            rec_blocks.append(_format_review_record_block(i, subs[i]))
    return '\n\n'.join(rec_blocks)


def apply_review_response(project_path, response_text, indices):
    """Parse a review response and write any record updates to the project
    JSON. Returns count of records updated."""
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
        e = subs[idx]
        if not isinstance(e.get('text'), dict):
            e['text'] = {'ja': _ja_of(e), 'ro': '', 'en': ''}
        e['text']['en'] = got['en']
        if got.get('lit'):
            e['text']['lit'] = got['lit']
        if got.get('note'):
            e['translator_note'] = got['note']
        e['new'] = True
        updated += 1
    if updated:
        with open(project_path, 'w', encoding='utf-8') as f:
            json.dump(project, f, indent=2, ensure_ascii=False)
    return updated


# ── Full review: chunked audit of every translated record ────────────────────

FULL_REVIEW_SYSTEM_PROMPT = (
    "You are a senior translation reviewer auditing existing Japanese-to-English "
    "subtitle translations for an anime production. The editor will hand you the "
    "full project context plus a chunk of records that already have an English "
    "translation. For each record, decide whether the existing English is "
    "correct AND idiomatic given the project context, character voices, "
    "vocabulary, and surrounding dialogue.\n\n"
    "OUTPUT RULES — follow exactly:\n"
    "- For each record that is FINE, output a single line: '<idx> OK' (just "
    "the integer index followed by space then OK).\n"
    "- For each record that should be IMPROVED, output the corrected record "
    "in the standard block format below. Always include the natural English "
    "line AND the literal <angle bracket> line, AND a *Note: brief reason* "
    "explaining what was wrong.\n"
    "- Do NOT flag records solely because they could be phrased differently. "
    "Only flag genuine issues: incorrect meaning, unnatural phrasing, voice "
    "inconsistency, mistranslated idioms, transcription errors in the JA, etc.\n"
    "- One block per record, blank lines between blocks.\n"
    "- [SPEAKER: …] is metadata only — never echo it in your output.\n\n"
    "RECORD FORMAT (when revising):\n"
    "<idx>\n"
    "<srt-time>\n"
    "[Japanese]\n"
    "(Romaji)\n"
    "Improved English translation.\n"
    "<Improved literal English translation.>\n"
    "*Note: brief reason for the change*\n\n"
    "EXAMPLE — chunk of 3 records, two are fine, one needs revision:\n"
    "5 OK\n\n"
    "6\n"
    "00:00:14,000 --> 00:00:17,000\n"
    "[いいえ、それは違うわ。]\n"
    "(Iie, sore wa chigau wa.)\n"
    "No, that's wrong.\n"
    "<No, that is different.>\n"
    "*Note: previous translation 'No way!' is too informal for this character — she's polite throughout the scene.*\n\n"
    "7 OK\n"
)


_OK_LINE_RE = re.compile(r'^\s*(\d+)\s+OK\s*$', re.IGNORECASE)


def _parse_full_review_response(response, expected_indices):
    """Walk the full-review response. Records appearing as '<idx> OK' lines
    are NOT in the result (no change). Records appearing as full blocks ARE
    in the result with their proposed values. Returns
    {idx: {'en', 'lit', 'note', 'block_text'}} where block_text is the raw
    record block string so the client can pipe it back to /apply-review
    verbatim."""
    out = {}
    blocks = re.split(r'\n\s*\n', (response or '').strip())
    expected = set(int(i) + 1 for i in expected_indices)
    for blk in blocks:
        lines = [l.rstrip() for l in blk.splitlines() if l.strip()]
        if not lines:
            continue
        # OK line
        ok = _OK_LINE_RE.match(lines[0])
        if ok and len(lines) == 1:
            continue  # no change → skip
        # Otherwise expect the standard record block
        try:
            idx_one = int(lines[0].strip())
        except ValueError:
            continue
        if idx_one not in expected:
            continue
        # Reuse the existing parser logic on a single block
        single = _parse_response(blk, [idx_one - 1])
        got = single.get(idx_one - 1)
        if got and got.get('en'):
            out[idx_one - 1] = dict(got)
            out[idx_one - 1]['block_text'] = blk
    return out


def full_review_project(project_path, options, on_step=None, on_progress=None):
    """
    options = {
      scope:        'all' | 'unreviewed' | 'indices',
      indices:      [int, ...]    # only used when scope == 'indices'
      chunk_size:   int           # default 10
    }
    Walks every in-scope record in chunks, asks Qwen to flag any that need
    revision, streams each suggestion as a progress event:
      {idx, current_en, current_lit, proposed_en, proposed_lit, note, block_text}
    The client renders these as diff cards with per-card Apply/Skip buttons.
    Does NOT mutate the project — applying suggestions goes through the
    existing /apply-review endpoint."""
    def step(msg):
        log.info(f'[full-review] {msg}')
        if on_step:
            on_step(msg)

    if not os.path.exists(project_path):
        raise FileNotFoundError(project_path)
    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)
    subs = project.get('subtitles') or []
    if not isinstance(subs, list) or not subs:
        raise RuntimeError('project has no subtitles list')
    ctx = project.get('context') or {}

    # Resolve scope → flat list of record indices
    scope = ((options or {}).get('scope') or 'unreviewed').lower()
    if scope == 'indices':
        raw = (options or {}).get('indices') or []
        targets = []
        for i in raw:
            try:
                targets.append(int(i))
            except (TypeError, ValueError):
                pass
    elif scope == 'all':
        targets = []
        for i, e in enumerate(subs):
            if not isinstance(e, dict): continue
            ja = _ja_of(e); en = _en_of(e)
            if not ja or _is_untranscribed(ja): continue
            if not en: continue
            targets.append(i)
    else:  # 'unreviewed'
        targets = []
        for i, e in enumerate(subs):
            if not isinstance(e, dict): continue
            if not e.get('new'): continue   # only the 🆕 records
            ja = _ja_of(e); en = _en_of(e)
            if not ja or _is_untranscribed(ja): continue
            if not en: continue
            targets.append(i)

    if not targets:
        step('Nothing in scope.')
        return {'reviewed': 0, 'suggested': 0, 'chunks': 0}

    chunk_size = max(1, int((options or {}).get('chunk_size') or 10))
    step(f'Scope: {scope} — {len(targets)} record(s), chunk size {chunk_size}')

    _ensure_loaded(on_step=on_step)

    static_block = _build_static_context(ctx)
    story = (ctx.get('story_so_far') or '').strip()

    chunks = [targets[i:i + chunk_size] for i in range(0, len(targets), chunk_size)]
    suggested = 0
    reviewed = 0
    chunks_done = 0

    with _translate_lock:
        for ci, chunk in enumerate(chunks, start=1):
            step(f'── Chunk {ci}/{len(chunks)} — records {chunk[0]+1}–{chunk[-1]+1} ──')

            # Build the user message
            blocks = ["=== PROJECT CONTEXT ===\n" + static_block] if static_block else []
            if story:
                blocks.append("=== STORY SO FAR ===\n" + story)
            chunk_lines = ["=== RECORDS TO AUDIT ==="]
            for i in chunk:
                chunk_lines.append(_format_review_record_block(i, subs[i]))
            blocks.append('\n\n'.join(chunk_lines))
            blocks.append("Audit each record above. For each, output either "
                          "'<idx> OK' on its own line, or a corrected record "
                          "block with a *Note* explaining the change.")
            user_msg = '\n\n'.join(blocks)

            messages = [
                {'role': 'system', 'content': FULL_REVIEW_SYSTEM_PROMPT},
                {'role': 'user',   'content': user_msg},
            ]

            try:
                response = _with_heartbeat(
                    f'Auditing chunk {ci}/{len(chunks)}', on_step,
                    lambda: _generate(messages, max_new_tokens=2048, temperature=0.2),
                )
            except Exception as ex:
                step(f'  ✗ Chunk {ci} generation failed: {ex}')
                continue

            parsed = _parse_full_review_response(response, chunk)
            reviewed += len(chunk)
            chunks_done += 1

            # Emit each suggestion (records with no change just don't appear).
            for idx in chunk:
                if idx not in parsed:
                    continue
                got = parsed[idx]
                e = subs[idx]
                cur_lane = e.get('text') if isinstance(e, dict) else {}
                cur_en  = (cur_lane.get('en')  if isinstance(cur_lane, dict) else '') or ''
                cur_lit = (cur_lane.get('lit') if isinstance(cur_lane, dict) else '') or ''
                start = float(e.get('start') or 0)
                end   = float(e.get('end')   or start)
                payload = {
                    'idx': idx,
                    'time': f"{_to_srt_time(start)} --> {_to_srt_time(end)}",
                    'ja': _ja_of(e),
                    'current_en':  cur_en,
                    'current_lit': cur_lit,
                    'proposed_en':  got.get('en')  or '',
                    'proposed_lit': got.get('lit') or '',
                    'note':         got.get('note') or '',
                    'block_text':   got.get('block_text') or '',
                }
                suggested += 1
                step(f'  💡 {idx + 1}: {(got.get("en") or "")[:60]}')
                if on_progress:
                    # Don't include a 'type' key here — the server's wrapping
                    # lambda adds {'type': 'progress', **p}, and Python's **
                    # spread lets the later (inner) key override. Setting
                    # 'type': 'suggestion' here would silently break the
                    # frontend, which listens for type === 'progress'.
                    on_progress(payload)
            step(f'  ✓ Chunk {ci} done — {len([i for i in chunk if i in parsed])} suggestion(s)')

    return {'reviewed': reviewed, 'suggested': suggested, 'chunks': chunks_done}


# ── Helpers shared with translate.py ─────────────────────────────────────────

def _ja_of(entry):
    text = entry.get('text') if isinstance(entry, dict) else None
    if isinstance(text, dict):
        return (text.get('ja') or '').strip()
    if isinstance(text, str):
        return text.strip()
    return ''


def _en_of(entry):
    text = entry.get('text') if isinstance(entry, dict) else None
    if isinstance(text, dict):
        return (text.get('en') or '').strip()
    return ''


def _is_untranscribed(ja):
    return (not ja) or (TARGET_MARKER in ja)


def _to_srt_time(secs):
    """0.0 → '00:00:00,000'."""
    secs = max(0.0, float(secs or 0))
    h = int(secs // 3600); m = int((secs % 3600) // 60)
    s = int(secs % 60); ms = int(round((secs - int(secs)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _bilingual_field(field, lane):
    if isinstance(field, dict):
        return (field.get(lane) or '').strip()
    if isinstance(field, str):
        return field.strip()
    return ''


def _scene_for_record(scenes, t):
    """Pick the scene whose [start,end] contains t. Falls through to the
    last one if no match."""
    if not scenes:
        return None
    best = None
    for s in scenes:
        if not isinstance(s, dict):
            continue
        try:
            st = float(s.get('start') or 0)
            en = float(s.get('end') or st)
        except (TypeError, ValueError):
            continue
        if st <= t < en:
            return s
        best = s
    return best


# ── Prompt construction ─────────────────────────────────────────────────────

def _build_static_context(ctx):
    """The bilingual project context every call sees, regardless of mode."""
    lines = []
    syn = _bilingual_field(ctx.get('synopsis'), 'en')
    if syn:
        lines.append(f"SYNOPSIS:\n{syn}")
    tone = _bilingual_field(ctx.get('tone'), 'en')
    if tone:
        lines.append(f"TONE: {tone}")

    chars = ctx.get('characters') or []
    if chars:
        char_lines = ["CHARACTERS:"]
        for c in chars:
            if not isinstance(c, dict):
                continue
            name = c.get('name') or {}
            en_name = (name.get('en') if isinstance(name, dict) else name) or ''
            ja_name = (name.get('ja') if isinstance(name, dict) else '') or ''
            desc = c.get('description') or {}
            en_desc = (desc.get('en') if isinstance(desc, dict) else desc) or ''
            entry = f"  • {en_name}"
            if ja_name and ja_name != en_name:
                entry += f" ({ja_name})"
            if en_desc:
                entry += f" — {en_desc}"
            char_lines.append(entry)
        lines.append('\n'.join(char_lines))

    vocab = ctx.get('vocabulary') or {}
    vocab_en = vocab.get('en') if isinstance(vocab, dict) else None
    if vocab_en:
        lines.append("VOCABULARY: " + ", ".join(v for v in vocab_en if v))

    scenes = ctx.get('scenes') or []
    if scenes:
        scene_lines = ["SCENES:"]
        for i, s in enumerate(scenes):
            if not isinstance(s, dict):
                continue
            try:
                st = float(s.get('start') or 0)
                en = float(s.get('end') or st)
            except (TypeError, ValueError):
                continue
            txt = (s.get('text') or '').strip()
            scene_lines.append(f"  {i+1}. {_to_srt_time(st)}–{_to_srt_time(en)}: {txt or '(no description)'}")
        lines.append('\n'.join(scene_lines))

    anns = ctx.get('annotations') or []
    if anns:
        ann_lines = ["ANNOTATIONS:"]
        for a in anns:
            if not isinstance(a, dict):
                continue
            try:
                t = float(a.get('start') or 0)
            except (TypeError, ValueError):
                continue
            txt = (a.get('text') or '').strip()
            ann_lines.append(f"  @ {_to_srt_time(t)}: {txt}")
        lines.append('\n'.join(ann_lines))

    return '\n\n'.join(lines)


def _format_record_block(idx, e, include_en=False, mark_translate=False):
    """Format one record for inclusion in the prompt."""
    ja = _ja_of(e)
    text = e.get('text') if isinstance(e, dict) else None
    ro = (text.get('ro') if isinstance(text, dict) else '') or ''
    en = _en_of(e) if include_en else ''
    speaker = e.get('speaker') if isinstance(e, dict) else None
    spk = ''
    if isinstance(speaker, dict):
        spk = (speaker.get('en') or speaker.get('ja') or '').strip()
    elif isinstance(speaker, str):
        spk = speaker.strip()

    start = float(e.get('start') or 0); end = float(e.get('end') or start)
    block = [
        str(idx + 1),
        f"{_to_srt_time(start)} --> {_to_srt_time(end)}",
        f"[{ja}]",
    ]
    if ro:
        block.append(f"({ro})")
    if en:
        block.append(en)
    if spk:
        # Square-bracket form so the model treats it as metadata, not as
        # text to translate or echo back.
        block.append(f"[SPEAKER: {spk}]")
    return '\n'.join(block)


def _build_full_prior(subs, before_idx):
    """Every translated record before `before_idx`, formatted compactly."""
    out = []
    for i in range(min(before_idx, len(subs))):
        e = subs[i]
        ja = _ja_of(e); en = _en_of(e)
        if not en or _is_untranscribed(ja):
            continue
        start = float(e.get('start') or 0); end = float(e.get('end') or start)
        out.append(f"{i+1}\n{_to_srt_time(start)} --> {_to_srt_time(end)}\n[{ja}]\n{en}")
    return '\n\n'.join(out)


def _build_prompt_messages(ctx, subs, indices, context_mode, style_hint=None):
    """Assemble the full chat-message list for one batch."""
    user_blocks = []

    static = _build_static_context(ctx)
    if static:
        user_blocks.append("=== PROJECT CONTEXT ===\n" + static)

    first_idx = indices[0]
    first_record_t = float(subs[first_idx].get('start') or 0)

    if context_mode == 'tldr':
        story = (ctx.get('story_so_far') or '').strip()
        if story:
            user_blocks.append("=== STORY SO FAR ===\n" + story)
    elif context_mode == 'full':
        prior = _build_full_prior(subs, first_idx)
        if prior:
            user_blocks.append("=== PRIOR TRANSLATED DIALOGUE ===\n" + prior)
    # 'close' mode adds nothing extra here

    active_scene = _scene_for_record(ctx.get('scenes') or [], first_record_t)
    if active_scene:
        scene_text = (active_scene.get('text') or '').strip()
        if scene_text:
            try:
                st = float(active_scene.get('start') or 0)
                en = float(active_scene.get('end') or st)
                user_blocks.append(
                    f"=== ACTIVE SCENE ({_to_srt_time(st)}–{_to_srt_time(en)}) ===\n{scene_text}"
                )
            except (TypeError, ValueError):
                pass

    # Close context: 3 records before the batch + 3 after
    target_set = set(indices)
    ctx_before = []
    for j in range(max(0, indices[0] - 3), indices[0]):
        ctx_before.append(_format_record_block(j, subs[j], include_en=True))
    ctx_after = []
    last_target = indices[-1]
    for j in range(last_target + 1, min(len(subs), last_target + 4)):
        if j in target_set:
            continue
        ctx_after.append(_format_record_block(j, subs[j], include_en=True))
    if ctx_before or ctx_after:
        ctx_lines = ["=== [CONTEXT — do not translate] ==="]
        if ctx_before:
            ctx_lines.append('\n\n'.join(ctx_before))
        if ctx_after:
            if ctx_before:
                ctx_lines.append('---')
            ctx_lines.append('\n\n'.join(ctx_after))
        user_blocks.append('\n'.join(ctx_lines))

    # The actual records to translate
    tr_blocks = ["=== [TRANSLATE] ==="]
    for i in indices:
        tr_blocks.append(_format_record_block(i, subs[i], include_en=False))
    user_blocks.append('\n\n'.join(tr_blocks))

    if style_hint and style_hint.strip():
        user_blocks.append("=== STYLE HINT ===\n" + style_hint.strip())

    return [
        {'role': 'system', 'content': SYSTEM_PROMPT},
        {'role': 'user',   'content': '\n\n'.join(user_blocks)},
    ]


# ── Output parsing ───────────────────────────────────────────────────────────

_NOTE_RE         = re.compile(r'^\*Note:\s*(.+?)\*?\s*$', re.IGNORECASE)
_SPEAKER_LINE_RE = re.compile(r'^\s*\[?\s*speaker\s*[:：]', re.IGNORECASE)
_LITERAL_RE      = re.compile(r'^<\s*(.+?)\s*>$')
# Catch trailing "Speaker: X" or "speaker: X" appended to the EN line itself.
_TRAILING_SPEAKER_RE = re.compile(r'\s*[\.\:]?\s*\[?\s*speaker\s*[:：][^\n\]\.]*\]?\s*[\.\:]*\s*$',
                                  re.IGNORECASE)


def _strip_speaker_artefacts(s):
    """Remove any 'Speaker: X' suffix the model may have appended even
    though we asked it not to. Idempotent."""
    if not s: return s
    cleaned = _TRAILING_SPEAKER_RE.sub('', s).rstrip()
    # Restore terminal punctuation if we stripped past it
    if cleaned and cleaned[-1] not in '.!?。、！？…':
        # Was there originally a period before the speaker tag? Add one back.
        if re.search(r'[\.!?。！？…]\s*\[?\s*speaker', s, re.IGNORECASE):
            cleaned += '.'
    return cleaned


def _parse_response(response, expected_indices):
    """Walk the model's response and pick out one block per expected index.
    Returns {idx: {'en': str, 'lit': str, 'note': str|None}}. Missing
    indices are omitted so the caller can flag them as failures."""
    out = {}
    blocks = re.split(r'\n\s*\n', (response or '').strip())
    expected = set(int(i) + 1 for i in expected_indices)  # 1-based in output
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
        # Walk the lines: skip time / [JA] / (romaji) / [SPEAKER:…] lines.
        # <literal> goes to its own bucket. Plain lines accumulate into EN
        # until we hit the *Note* line.
        en_parts = []
        lit = ''
        note = None
        for l in lines[1:]:
            if _NOTE_RE.match(l):
                note = _NOTE_RE.match(l).group(1).strip()
                break
            if '-->' in l:
                continue
            lit_m = _LITERAL_RE.match(l)
            if lit_m:
                lit = lit_m.group(1).strip()
                continue
            if l.startswith('[') and l.endswith(']'):
                continue
            if l.startswith('(') and l.endswith(')'):
                continue
            if _SPEAKER_LINE_RE.match(l):
                continue
            en_parts.append(l)
        en = _strip_speaker_artefacts(' '.join(en_parts).strip())
        if en:
            out[idx_one - 1] = {'en': en, 'lit': lit, 'note': note}
    return out


# ── Story-so-far summary ─────────────────────────────────────────────────────

SUMMARY_THRESHOLD = 10  # auto-regen after this many newly-translated records

SUMMARY_SYSTEM = (
    "You are a story editor summarising what has happened so far in an "
    "anime production. Be concise and concrete: focus on plot beats, "
    "character relationships, and any reveals or shifts. The summary will "
    "be used as background context for translating later dialogue."
)


def _build_summary_user_message(ctx, subs, through_idx):
    parts = []
    static = _build_static_context(ctx)
    if static:
        parts.append("=== PROJECT CONTEXT ===\n" + static)
    dialogue = []
    for i in range(min(through_idx + 1, len(subs))):
        en = _en_of(subs[i])
        if not en or _is_untranscribed(_ja_of(subs[i])):
            continue
        dialogue.append(f"{i+1}: {en}")
    if dialogue:
        parts.append("=== TRANSLATED DIALOGUE SO FAR ===\n" + '\n'.join(dialogue))
    parts.append(
        "Write a ≤200 word English summary of the story so far. Plain prose, "
        "no bullet points. Cover key plot events, character relationships, "
        "and any reveals or twists."
    )
    return '\n\n'.join(parts)


def refresh_story_summary(project_path, on_step=None):
    """Force-regenerate project.context.story_so_far from the current
    translated EN lines. Loads Qwen if not loaded."""
    def step(msg):
        log.info(f'[summary] {msg}')
        if on_step:
            on_step(msg)

    if not os.path.exists(project_path):
        raise FileNotFoundError(f'project json missing: {project_path}')
    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)
    subs = project.get('subtitles') or []
    ctx = project.get('context') or {}

    highest = -1
    for i, e in enumerate(subs):
        if _en_of(e) and not _is_untranscribed(_ja_of(e)):
            highest = i
    if highest < 0:
        step('Nothing translated yet — story summary skipped.')
        return ''

    _ensure_loaded(on_step=on_step)

    step(f'Generating summary covering records 1–{highest + 1}…')
    messages = [
        {'role': 'system', 'content': SUMMARY_SYSTEM},
        {'role': 'user',   'content': _build_summary_user_message(ctx, subs, highest)},
    ]
    response = _generate(messages, max_new_tokens=512, temperature=0.3).strip()

    ctx['story_so_far'] = response
    ctx['story_so_far_through_idx'] = highest
    project['context'] = ctx
    with open(project_path, 'w', encoding='utf-8') as f:
        json.dump(project, f, indent=2, ensure_ascii=False)

    step(f'✓ Summary saved ({len(response)} chars)')
    return response


SUMMARY_AFTER_SYSTEM = (
    "You are a story editor summarising what happens AFTER a particular point "
    "in an anime production. Be concise and concrete: focus on plot beats, "
    "character developments, and any reveals or shifts that occur in the "
    "supplied dialogue. The summary will be used as forward-looking context "
    "for revising earlier translations."
)


def _build_summary_after_user_message(ctx, subs, from_idx):
    parts = []
    static = _build_static_context(ctx)
    if static:
        parts.append("=== PROJECT CONTEXT ===\n" + static)
    dialogue = []
    for i in range(from_idx, len(subs)):
        en = _en_of(subs[i])
        if not en or _is_untranscribed(_ja_of(subs[i])):
            continue
        dialogue.append(f"{i+1}: {en}")
    if dialogue:
        parts.append(f"=== TRANSLATED DIALOGUE FROM RECORD {from_idx+1} ONWARDS ===\n" + '\n'.join(dialogue))
    parts.append(
        "Write a ≤200 word English summary of what happens AFTER the review "
        "point. Plain prose, no bullet points. Cover key plot events, "
        "character developments, and any reveals."
    )
    return '\n\n'.join(parts)


def refresh_story_after(project_path, from_idx, on_step=None):
    """Generate a forward-looking summary covering translated records from
    `from_idx` (0-based, exclusive — summary covers from_idx+1 onwards) to
    the end of the project. Used by the Review tab so the AI sees what
    happens AFTER the records being reviewed.

    Stored at:
        project.context.story_after        — the summary text
        project.context.story_after_from   — the from_idx it covers (0-based)
        project.context.story_after_through — highest covered idx (0-based)
    """
    def step(msg):
        log.info(f'[story-after] {msg}')
        if on_step:
            on_step(msg)

    if not os.path.exists(project_path):
        raise FileNotFoundError(f'project json missing: {project_path}')
    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)
    subs = project.get('subtitles') or []
    ctx = project.get('context') or {}

    # Find the highest translated idx >= from_idx + 1
    highest = -1
    start_after = from_idx + 1
    for i in range(start_after, len(subs)):
        if _en_of(subs[i]) and not _is_untranscribed(_ja_of(subs[i])):
            highest = i
    if highest < 0:
        step('No translated records after the review point.')
        ctx.pop('story_after', None)
        ctx.pop('story_after_from', None)
        ctx.pop('story_after_through', None)
        project['context'] = ctx
        with open(project_path, 'w', encoding='utf-8') as f:
            json.dump(project, f, indent=2, ensure_ascii=False)
        return ''

    _ensure_loaded(on_step=on_step)

    step(f'Generating after-summary covering records {start_after + 1}–{highest + 1}…')
    messages = [
        {'role': 'system', 'content': SUMMARY_AFTER_SYSTEM},
        {'role': 'user',   'content': _build_summary_after_user_message(ctx, subs, start_after)},
    ]
    response = _generate(messages, max_new_tokens=512, temperature=0.3).strip()

    ctx['story_after'] = response
    ctx['story_after_from'] = from_idx
    ctx['story_after_through'] = highest
    project['context'] = ctx
    with open(project_path, 'w', encoding='utf-8') as f:
        json.dump(project, f, indent=2, ensure_ascii=False)

    step(f'✓ After-summary saved ({len(response)} chars)')
    return response


def _maybe_auto_refresh_summary(project_path, project, on_step):
    """Called inside a translate_batch run when context_mode='tldr'."""
    subs = project.get('subtitles') or []
    ctx = project.get('context') or {}
    highest = -1
    for i, e in enumerate(subs):
        if _en_of(e) and not _is_untranscribed(_ja_of(e)):
            highest = i
    last = ctx.get('story_so_far_through_idx', -1)
    if highest - last >= SUMMARY_THRESHOLD or (not ctx.get('story_so_far') and highest >= 0):
        on_step and on_step(f'Auto-refreshing story summary (last covered: {last + 1}, now: {highest + 1})…')
        try:
            refresh_story_summary(project_path, on_step=on_step)
        except Exception as ex:
            log.warning(f'auto-summary refresh failed: {ex}')


# ── Main batch runner ────────────────────────────────────────────────────────

def translate_batch(project_path, indices, options, on_step=None, on_progress=None):
    """
    options = {
      context_mode: 'full' | 'tldr' | 'close',
      force:        bool,
      style_hint:   optional extra user message
    }
    """
    def step(msg):
        log.info(f'[adv-translate] {msg}')
        if on_step:
            on_step(msg)

    if not os.path.exists(project_path):
        raise FileNotFoundError(f'project json missing: {project_path}')
    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)

    subs = project.get('subtitles') or []
    if not isinstance(subs, list) or not subs:
        raise RuntimeError('project has no subtitles list')

    ctx = project.get('context') or {}
    context_mode = ((options or {}).get('context_mode') or 'tldr').lower()
    if context_mode not in ('full', 'tldr', 'close'):
        context_mode = 'tldr'
    force = bool((options or {}).get('force'))
    style_hint = (options or {}).get('style_hint') or ''

    # Filter indices: must be in range, not untranscribed, and (unless force)
    # not already translated.
    raw = []
    for i in (indices or []):
        try:
            raw.append(int(i))
        except (TypeError, ValueError):
            continue
    targets = []
    for i in raw:
        if not (0 <= i < len(subs)):
            continue
        if _is_untranscribed(_ja_of(subs[i])):
            continue
        if not force and _en_of(subs[i]):
            continue
        targets.append(i)
    targets.sort()

    if not targets:
        step('Nothing to translate in this batch (all empty / ???? / already done).')
        return {'translated': 0, 'failed': 0, 'total': 0, 'notes_added': 0}

    step(f'Mode: {context_mode} · {len(targets)} record(s) in batch')

    _ensure_loaded(on_step=on_step)

    if context_mode == 'tldr':
        _maybe_auto_refresh_summary(project_path, project, on_step)
        # Reload project after possible summary write so the prompt sees it
        with open(project_path, encoding='utf-8') as f:
            project = json.load(f)
        subs = project.get('subtitles') or []
        ctx = project.get('context') or {}

    messages = _build_prompt_messages(ctx, subs, targets, context_mode, style_hint)
    step(f'Prompt assembled ({sum(len(m["content"]) for m in messages)} chars)')

    translated = 0
    failed = 0
    notes_added = 0

    with _translate_lock:
        try:
            response = _with_heartbeat(
                f'Generating {len(targets)} translation(s)', on_step,
                lambda: _generate(messages, max_new_tokens=2048, temperature=0.3),
            )
        except Exception as ex:
            step(f'  ✗ Generation failed: {ex}')
            return {'translated': 0, 'failed': len(targets), 'total': len(targets), 'notes_added': 0}

        parsed = _parse_response(response, targets)

        for idx in targets:
            got = parsed.get(idx)
            if not got or not got.get('en'):
                step(f'  ✗ {idx + 1}: missing in response')
                failed += 1
                continue
            e = subs[idx]
            if not isinstance(e.get('text'), dict):
                e['text'] = {'ja': _ja_of(e), 'ro': '', 'en': ''}
            e['text']['en'] = got['en']
            if got.get('lit'):
                e['text']['lit'] = got['lit']
            else:
                # Don't leak a stale lit from a prior run when the model
                # forgot to emit one this time.
                e['text'].pop('lit', None)
            if got.get('note'):
                e['translator_note'] = got['note']
                notes_added += 1
            else:
                e.pop('translator_note', None)
            e['new'] = True
            translated += 1
            step(f'  ✓ {idx + 1}: {got["en"][:60]}{"…" if len(got["en"]) > 60 else ""}'
                 + (f'  📝' if got.get('note') else ''))
            if on_progress:
                on_progress({
                    'idx': idx, 'status': 'translated',
                    'en': got['en'],
                    'lit': got.get('lit') or '',
                    'translator_note': got.get('note') or '',
                })

        # Persist
        try:
            with open(project_path, 'w', encoding='utf-8') as f:
                json.dump(project, f, indent=2, ensure_ascii=False)
        except Exception as ex:
            log.error(f'save failed: {ex}')

    return {
        'translated': translated, 'failed': failed,
        'total': len(targets), 'notes_added': notes_added,
    }
