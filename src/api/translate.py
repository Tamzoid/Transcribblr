"""
Transcribblr — Project translation
Walks a project's subtitles and fills in text.en for every record that has a
real Japanese transcription. Reuses the C3TR-Adapter (Gemma-2-9B + PEFT)
that context.py already loads, mirroring the upstream Step 6 script's prompt
+ generation params verbatim.

Skip rules (matches the script):
  • record's text.ja is empty            → skip
  • record's text.ja contains '????'    → skip (untranscribed)
  • record already has text.en           → skip (resume), unless force=True
"""

import os
import json
import threading

from logger import log
import context as _ctx

TARGET_MARKER = '????'

# Default style tags from the upstream Step 6 notebook. The Advanced sub-tab
# can override these per-run via options['style_tags'].
DEFAULT_STYLE_TAGS = ['nsfw', 'slang']

_translate_lock = threading.Lock()


def _build_instruction(style_tags):
    parts = ['Translate Japanese to English.']
    for tag in (style_tags or []):
        tag = (tag or '').strip()
        if not tag:
            continue
        parts.append(f'[writing_style: {tag}]')
    return '\n'.join(parts)


def translate_one(jp_text: str, style_tags=None) -> str:
    """One-shot Japanese → English translation. Loads C3TR if not loaded."""
    if not jp_text or not jp_text.strip():
        return ''
    instruction = _build_instruction(style_tags or DEFAULT_STYLE_TAGS)
    return _ctx.run_prompt(instruction, jp_text.strip(), max_new_tokens=256)


def _ja_of(entry) -> str:
    text = entry.get('text') if isinstance(entry, dict) else None
    if isinstance(text, dict):
        return (text.get('ja') or '').strip()
    if isinstance(text, str):
        return text.strip()
    return ''


def _en_of(entry) -> str:
    text = entry.get('text') if isinstance(entry, dict) else None
    if isinstance(text, dict):
        return (text.get('en') or '').strip()
    return ''


def _is_untranscribed(ja: str) -> bool:
    return (not ja) or (TARGET_MARKER in ja)


def find_pending_indices(subtitles, force=False):
    """Indices that need translating: have real JA and (no EN yet OR force)."""
    out = []
    for i, e in enumerate(subtitles or []):
        if not isinstance(e, dict):
            continue
        ja = _ja_of(e)
        if _is_untranscribed(ja):
            continue
        if not force and _en_of(e):
            continue
        out.append(i)
    return out


def translate_project(project_path: str, options: dict,
                      on_step=None, on_progress=None):
    """
    options = {
      'style_tags': ['nsfw', 'slang', ...]   # default DEFAULT_STYLE_TAGS
      'force':      bool                      # re-translate even if EN exists
      'indices':    [int, ...]                # subset of records, or omit for all pending
    }
    """
    def step(msg):
        log.info(f'[translate] {msg}')
        if on_step:
            on_step(msg)

    if not os.path.exists(project_path):
        raise FileNotFoundError(f'project json missing: {project_path}')

    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)

    subs = project.get('subtitles') or []
    if not isinstance(subs, list) or not subs:
        raise RuntimeError('project has no subtitles list')

    style_tags = options.get('style_tags') if options else None
    if not style_tags:
        style_tags = list(DEFAULT_STYLE_TAGS)
    force = bool((options or {}).get('force'))

    # Pick targets
    if options and options.get('indices'):
        targets = []
        for i in options['indices']:
            try:
                idx = int(i)
            except (TypeError, ValueError):
                continue
            if 0 <= idx < len(subs):
                targets.append(idx)
        # Still skip untranscribed even if explicitly requested
        targets = [i for i in targets if not _is_untranscribed(_ja_of(subs[i]))]
    else:
        targets = find_pending_indices(subs, force=force)

    if not targets:
        step('Nothing to translate.')
        return {'translated': 0, 'failed': 0, 'total': 0}

    skipped = sum(1 for e in subs if _is_untranscribed(_ja_of(e)))
    step(f'{len(targets)} record(s) to translate ({skipped} untranscribed will be skipped)')
    step(f'Style tags: {", ".join(style_tags) if style_tags else "(none)"}')

    # Make sure C3TR is loaded — emits its own progress lines on first load.
    _ctx.ensure_loaded(on_step=on_step)

    translated = 0
    failed = 0

    with _translate_lock:
        for n, idx in enumerate(targets):
            e = subs[idx]
            ja = _ja_of(e)
            try:
                en = translate_one(ja, style_tags=style_tags).strip()
            except Exception as ex:
                step(f'  ✗ {idx}: {ex}')
                failed += 1
                continue

            if not en:
                step(f'  · {idx}: (empty translation)')
                failed += 1
                continue

            if not isinstance(e.get('text'), dict):
                e['text'] = {'ja': ja, 'ro': '', 'en': ''}
            e['text']['en'] = en
            translated += 1

            preview_ja = ja[:40] + ('…' if len(ja) > 40 else '')
            preview_en = en[:40] + ('…' if len(en) > 40 else '')
            step(f'  ✓ {idx}: {preview_ja} → {preview_en}')
            if on_progress:
                on_progress({
                    'idx': idx, 'status': 'translated',
                    'ja': ja, 'en': en,
                    'remaining': len(targets) - (n + 1),
                })

            # Persist after every record so a crash doesn't lose work.
            try:
                with open(project_path, 'w', encoding='utf-8') as f:
                    json.dump(project, f, indent=2, ensure_ascii=False)
            except Exception as ex:
                log.warning(f'mid-job save failed: {ex}')

    # Final save (covers the case where the loop exits without persisting)
    try:
        with open(project_path, 'w', encoding='utf-8') as f:
            json.dump(project, f, indent=2, ensure_ascii=False)
    except Exception as ex:
        log.error(f'final save failed: {ex}')

    return {'translated': translated, 'failed': failed, 'total': len(targets)}
