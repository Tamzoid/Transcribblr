"""
Transcribblr — SRT helpers
Parse and write SubRip (.srt) subtitle files.
"""

import os
import re
from logger import log

TIME_RE = re.compile(r"(\d+):(\d+):(\d+),(\d+)")


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


def load_srt(path: str) -> list:
    """Parse an SRT file into a list of {start, end, text} dicts."""
    if not os.path.exists(path):
        log.warning(f"SRT not found: {path}")
        return []
    with open(path, encoding='utf-8') as f:
        blocks = f.read().strip().replace('\r\n', '\n').split('\n\n')
    out = []
    for b in blocks:
        lines = b.splitlines()
        if len(lines) >= 2:
            try:
                s, e = lines[1].split(' --> ')
                out.append({
                    'start': to_sec(s.strip()),
                    'end':   to_sec(e.strip()),
                    'text':  '\n'.join(lines[2:]) if len(lines) > 2 else '',
                })
            except Exception:
                continue
    log.debug(f"Loaded {len(out)} records from {os.path.basename(path)}")
    return out


def write_srt(entries: list, path: str):
    """Write a list of {start, end, text} dicts to an SRT file."""
    with open(path, 'w', encoding='utf-8') as f:
        for i, e in enumerate(entries):
            f.write(f"{i + 1}\n{to_ts(e['start'])} --> {to_ts(e['end'])}\n{e['text']}\n\n")
    log.info(f"Saved {len(entries)} records → {os.path.basename(path)}")
