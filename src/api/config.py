"""
Transcribblr — Config
Loads settings and holds mutable runtime state (selected file, audio paths).
"""

import os
import json
import threading
from logger import log

# ── Paths (resolved at runtime by configure()) ────────────────────────────────

SRT_DIR        = ''
STREAMABLE_DIR = ''
PORT           = 8765
LOG_DIR        = ''

# ── Runtime state — mutated by audio.load_file() ─────────────────────────────

state_lock = threading.Lock()
state = {
    'selected':    '',
    'audio_paths': {},   # {'vocals': '/path/to/x.vocals.m4a', 'full': '...'}
    'audio_path':  '',   # first available path
}


# ── Config loading ─────────────────────────────────────────────────────────────

def configure(settings: dict):
    """Apply a settings dict to the global config. Called by server.launch()."""
    global SRT_DIR, STREAMABLE_DIR, PORT, LOG_DIR

    SRT_DIR        = settings['srt_dir']
    STREAMABLE_DIR = settings.get('streamable_dir', '')
    PORT           = settings.get('port', 8765)
    LOG_DIR        = settings.get('log_dir', '')

    os.makedirs(SRT_DIR, exist_ok=True)

    # Re-init logger with log dir now that we know it
    if LOG_DIR:
        from logger import get_logger
        get_logger(log_dir=LOG_DIR)

    state['selected'] = settings.get('selected', '')

    log.info(f"Config applied — SRT: {SRT_DIR}")
    log.info(f"Streamable: {STREAMABLE_DIR or '(none)'}")
    log.info(f"Port: {PORT}")


def load_from_file(path: str):
    """Load config from a JSON file (used when running outside Colab)."""
    with open(path) as f:
        configure(json.load(f))


def list_srt_files():
    """Return sorted list of .srt filenames in SRT_DIR."""
    if not SRT_DIR or not os.path.exists(SRT_DIR):
        return []
    return sorted(f for f in os.listdir(SRT_DIR) if f.endswith('.srt'))
