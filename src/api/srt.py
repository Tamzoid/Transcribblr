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


def parse_srt_text(text: str) -> list:
    """Parse SRT-formatted text into a list of {start, end, text} dicts."""
    blocks = text.strip().replace('\r\n', '\n').split('\n\n')
    out = []
    for b in blocks:
        lines = [l for l in b.splitlines() if l.strip() != '']
        if len(lines) < 2:
            continue
        # First line may be an index or already the timestamp
        ts_idx = 1 if ' --> ' in lines[1] else 0 if ' --> ' in lines[0] else -1
        if ts_idx < 0:
            continue
        try:
            s, e = lines[ts_idx].split(' --> ')
            text_lines = lines[ts_idx + 1:]
            out.append({
                'start': to_sec(s.strip()),
                'end':   to_sec(e.strip().split(' ')[0]),  # VTT may have cue settings after timestamp
                'text':  '\n'.join(text_lines),
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
    """Write a list of {start, end, text} dicts to an SRT file."""
    with open(path, 'w', encoding='utf-8') as f:
        for i, e in enumerate(entries):
            f.write(f"{i + 1}\n{to_ts(e['start'])} --> {to_ts(e['end'])}\n{e['text']}\n\n")
    log.info(f"Saved {len(entries)} records → {os.path.basename(path)}")
