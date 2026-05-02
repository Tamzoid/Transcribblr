"""
Transcribblr — SRT helpers
Parse and write SubRip (.srt) subtitle files.
"""

import os
import re
from logger import log

TIME_RE = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)")


def to_sec(t) -> float:
    """Convert an SRT timestamp string or number to seconds."""
    if isinstance(t, (int, float)):
        return float(t)
    m = TIME_RE.match(str(t))
    if not m:
        return 0.0
    return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) + int(m[4]) / 1000


def to_ts(t: float) -> str:
    """Convert seconds to an SRT timestamp string."""
    t = max(0.0, t)
    h, r = divmod(t, 3600)
    m, s = divmod(r, 60)
    return f"{int(h):02}:{int(m):02}:{int(s):02},{int(round((s % 1) * 1000)):03}"


def parse_text_lanes(text: str) -> dict:
    """Parse a multi-line subtitle string with the [JA] / (RO) / EN / <LIT>
    bracket convention into structured lanes."""
    if not text:
        return {'ja': '', 'ro': '', 'en': '', 'lit': ''}
    ja, ro, lit, en_lines = '', '', '', []
    for line in text.replace('\r\n', '\n').split('\n'):
        s = line.strip()
        if not s:
            continue
        if s[0] == '[' and s[-1] == ']':
            ja = s[1:-1]
        elif s[0] == '(' and s[-1] == ')':
            ro = s[1:-1]
        elif s[0] == '<' and s[-1] == '>':
            lit = s[1:-1]
        else:
            en_lines.append(s)
    return {'ja': ja, 'ro': ro, 'en': '\n'.join(en_lines), 'lit': lit}


def lanes_to_text(t) -> str:
    """Reverse of parse_text_lanes — build a bracketed multi-line string from
    a {ja, ro, en, lit} dict (or pass through if it's already a string)."""
    if isinstance(t, str):
        return t
    if not isinstance(t, dict):
        return ''
    parts = []
    if t.get('ja'):  parts.append('[' + t['ja']  + ']')
    if t.get('ro'):  parts.append('(' + t['ro']  + ')')
    if t.get('en'):  parts.append(t['en'])
    if t.get('lit'): parts.append('<' + t['lit'] + '>')
    return '\n'.join(parts)


def normalise_text(t):
    """Coerce an entry's `text` field into the {ja, ro, en, lit} dict form."""
    if isinstance(t, dict):
        return {'ja':  t.get('ja',  '') or '',
                'ro':  t.get('ro',  '') or '',
                'en':  t.get('en',  '') or '',
                'lit': t.get('lit', '') or ''}
    return parse_text_lanes(t or '')


def parse_srt_text(text: str) -> list:
    """Parse SRT-formatted text into a list of {start, end, text:{ja,ro,en}} dicts."""
    blocks = text.strip().replace('\r\n', '\n').split('\n\n')
    out = []
    for b in blocks:
        lines = [l for l in b.splitlines() if l.strip() != '']
        if len(lines) < 2:
            continue
        ts_idx = 1 if ' --> ' in lines[1] else 0 if ' --> ' in lines[0] else -1
        if ts_idx < 0:
            continue
        try:
            s, e = lines[ts_idx].split(' --> ')
            text_lines = lines[ts_idx + 1:]
            out.append({
                'start': to_sec(s.strip()),
                'end':   to_sec(e.strip().split(' ')[0]),
                'text':  parse_text_lanes('\n'.join(text_lines)),
            })
        except Exception:
            continue
    return out


def parse_vtt_text(text: str) -> list:
    """Parse WebVTT text into a list of {start, end, text} dicts."""
    text = text.replace('\r\n', '\n').strip()
    # Drop WEBVTT header line + any header block
    if text.startswith('WEBVTT'):
        parts = text.split('\n\n', 1)
        text = parts[1] if len(parts) > 1 else ''
    # VTT uses "." for ms separator; SRT uses ",". Normalise so the SRT timestamp regex matches.
    import re as _re
    text = _re.sub(r'(\d{2}):(\d{2}):(\d{2})\.(\d{3})', r'\1:\2:\3,\4', text)
    return parse_srt_text(text)


def parse_subtitles(text: str, filename: str = '') -> list:
    """Parse SRT, VTT, or TXT (assumed SRT-format) content into entries."""
    stripped = text.lstrip()
    ext = os.path.splitext(filename)[1].lower()
    if ext == '.vtt' or stripped.startswith('WEBVTT'):
        return parse_vtt_text(text)
    return parse_srt_text(text)


def load_srt(path: str) -> list:
    """Parse an SRT file into a list of {start, end, text} dicts."""
    if not os.path.exists(path):
        log.warning(f"SRT not found: {path}")
        return []
    with open(path, encoding='utf-8') as f:
        out = parse_srt_text(f.read())
    log.debug(f"Loaded {len(out)} records from {os.path.basename(path)}")
    return out


def write_srt(entries: list, path: str):
    """Write a list of subtitle entries to an SRT file. Accepts either the new
    text:{ja,ro,en} dict shape or a legacy plain string."""
    with open(path, 'w', encoding='utf-8') as f:
        for i, e in enumerate(entries):
            f.write(f"{i + 1}\n{to_ts(e['start'])} --> {to_ts(e['end'])}\n"
                    f"{lanes_to_text(e.get('text', ''))}\n\n")
    log.info(f"Saved {len(entries)} records → {os.path.basename(path)}")
