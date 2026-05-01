"""
Transcribblr — Pre-transcription prompt prep
Cheap (no GPU): turns a project's bilingual context into per-scene Whisper
prompts, parses subtitles for partial hints, runs a budget check, and writes
the result onto project.context.prompts / project.context.hints.

Schema produced:
  context.prompts = {
    "default":  {en, ja, char_count, truncation_warning?},
    "<scene_start_seconds>": {en, ja, char_count, truncation_warning?},
    ...
  }
  context.hints = {
    "<entry_idx>": "<raw text containing ???? markers>",
    ...
  }
"""

import re

# Match the prompt budget knobs from the original Step 5b notebook so the
# same warnings surface whether you pre-process here or in Colab.
WARN_LIMIT           = 160
ERROR_LIMIT          = 200
RUNTIME_BUFFER_CHARS = 40
TARGET_MARKER        = '????'


def _str(v):
    if v is None:
        return ''
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, dict):
        # bilingual {ja, en} field — return whichever lane was asked for via _ja/_en
        return ''
    return str(v)


def _bilingual(field, lane):
    """Pull lane out of a bilingual {ja, en} object, tolerating plain strings."""
    if isinstance(field, dict):
        return _str(field.get(lane))
    if isinstance(field, str):
        return field.strip()
    return ''


def _character_names(chars, lane):
    out = []
    for c in (chars or []):
        n = (c or {}).get('name') if isinstance(c, dict) else None
        v = _bilingual(n, lane)
        if v:
            out.append(v)
    return out


def _vocab_list(vocab, lane):
    if isinstance(vocab, dict):
        return [v for v in (vocab.get(lane) or []) if v]
    if isinstance(vocab, list):
        return [_bilingual(v, lane) or _str(v) for v in vocab if v]
    return []


def _assemble_en(chars_en, vocab_en, desc_en, tone_en, scene_en=None):
    parts = []
    if chars_en:
        parts.append(', '.join(chars_en) + '.')
    if vocab_en:
        parts.append(', '.join(vocab_en) + '.')
    if desc_en:
        parts.append(desc_en + ' ')
    if tone_en:
        parts.append(tone_en + '.')
    if scene_en:
        parts.append(scene_en + '.')
    return ''.join(parts).strip()


def _assemble_ja(chars_ja, vocab_ja, desc_ja, tone_ja, scene_ja=None):
    parts = []
    if chars_ja:
        parts.append('登場人物は' + '、'.join(chars_ja) + '。')
    if vocab_ja:
        parts.append('、'.join(vocab_ja) + '。')
    if desc_ja:
        parts.append(desc_ja + '。')
    if tone_ja:
        parts.append(tone_ja + '。')
    if scene_ja:
        parts.append(scene_ja + '。')
    return ''.join(parts).strip()


def _budget_check(ja, label):
    n = len(ja)
    if n <= WARN_LIMIT:
        return None
    runtime_total = n + RUNTIME_BUFFER_CHARS
    chars_over    = max(0, runtime_total - ERROR_LIMIT)
    likely_lost   = ja[:chars_over] if chars_over else ''
    return {
        'level':      'error' if n > ERROR_LIMIT else 'warning',
        'label':      label,
        'char_count': n,
        'warn_limit': WARN_LIMIT,
        'error_limit': ERROR_LIMIT,
        'likely_lost': likely_lost or None,
    }


def _build_entry(chars_ja, chars_en, vocab_ja, vocab_en,
                 desc_ja, desc_en, tone_ja, tone_en,
                 scene_text, label):
    # Scenes carry plain-English `text` only — pass it through as a hint on the
    # English side; the Japanese side stays anchored to the global description
    # since per-scene JA isn't available in this schema.
    en = _assemble_en(chars_en, vocab_en, desc_en, tone_en, scene_text)
    ja = _assemble_ja(chars_ja, vocab_ja, desc_ja, tone_ja, None)
    entry = {'en': en, 'ja': ja, 'char_count': len(ja)}
    warn = _budget_check(ja, label)
    if warn:
        entry['truncation_warning'] = warn
    return entry


def build_prompts(ctx: dict) -> dict:
    """Build the per-scene prompts dict from a bilingual project context."""
    if not ctx:
        return {}
    chars_ja = _character_names(ctx.get('characters'), 'ja')
    chars_en = _character_names(ctx.get('characters'), 'en')
    vocab_ja = _vocab_list(ctx.get('vocabulary'), 'ja')
    vocab_en = _vocab_list(ctx.get('vocabulary'), 'en')
    desc_ja  = _bilingual(ctx.get('description'), 'ja')
    desc_en  = _bilingual(ctx.get('description'), 'en')
    tone_ja  = _bilingual(ctx.get('tone'), 'ja')
    tone_en  = _bilingual(ctx.get('tone'), 'en')

    out = {
        'default': _build_entry(chars_ja, chars_en, vocab_ja, vocab_en,
                                desc_ja, desc_en, tone_ja, tone_en,
                                None, 'default'),
    }
    for s in (ctx.get('scenes') or []):
        if not isinstance(s, dict):
            continue
        try:
            key = f"{float(s.get('start') or 0):.3f}"
        except (TypeError, ValueError):
            continue
        scene_text = _str(s.get('text'))
        out[key] = _build_entry(chars_ja, chars_en, vocab_ja, vocab_en,
                                desc_ja, desc_en, tone_ja, tone_en,
                                scene_text, f'scene @{key}')
    return out


def parse_partial_hints(subtitles: list) -> dict:
    """Find subtitle entries whose JA text contains ???? markers but isn't
    purely the placeholder, so the model can use surrounding fragments as
    context. Keyed by entry index (string for JSON friendliness)."""
    hints = {}
    for i, e in enumerate(subtitles or []):
        if not isinstance(e, dict):
            continue
        text = e.get('text')
        ja = ''
        if isinstance(text, dict):
            ja = _str(text.get('ja'))
        elif isinstance(text, str):
            ja = text.strip()
        if not ja or TARGET_MARKER not in ja:
            continue
        if ja == TARGET_MARKER:
            continue
        hints[str(i)] = ja
    return hints


def find_pending_indices(subtitles: list) -> list:
    """Indices of records that still need transcribing (any ???? in JA)."""
    out = []
    for i, e in enumerate(subtitles or []):
        if not isinstance(e, dict):
            continue
        text = e.get('text')
        ja = ''
        if isinstance(text, dict):
            ja = _str(text.get('ja'))
        elif isinstance(text, str):
            ja = text.strip()
        if TARGET_MARKER in ja:
            out.append(i)
    return out


def parse_partial_hint_parts(text: str) -> dict:
    """Pull the prefix/suffix/middle out of a single record's JA text so the
    transcriber can show what was already known."""
    clean = (text or '').strip().lstrip('★')
    if clean == TARGET_MARKER:
        return {'prefix': None, 'suffix': None, 'middle': None, 'is_partial': False}
    m = re.match(r'^\?\?\?\?\s+(.+?)\s+\?\?\?\?$', clean)
    if m:
        return {'prefix': None, 'suffix': None, 'middle': m.group(1), 'is_partial': True}
    m = re.match(r'^\?\?\?\?\s+(.+)$', clean)
    if m:
        return {'prefix': None, 'suffix': m.group(1), 'middle': None, 'is_partial': True}
    m = re.match(r'^(.+?)\s+\?\?\?\?$', clean)
    if m:
        return {'prefix': m.group(1), 'suffix': None, 'middle': None, 'is_partial': True}
    return {'prefix': None, 'suffix': None, 'middle': None, 'is_partial': False}
