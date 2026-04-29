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


def _parse_env_file(path: str) -> dict:
    """Parse a simple .env file into a dict."""
    result = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' not in line:
                continue
            key, value = line.split('=', 1)
            result[key.strip()] = value.strip().strip('"').strip("'")
    return result


def load_from_env(path: str = None):
    """Load configuration from a .env file."""
    if path is None:
        path = os.path.join(os.getcwd(), '.env')
    if not os.path.exists(path):
        raise FileNotFoundError(f"Env file not found: {path}")

    raw = _parse_env_file(path)
    base_dir = os.path.dirname(os.path.abspath(path))

    def resolve(key: str) -> str:
        value = raw.get(key, '')
        if not value:
            return ''
        return value if os.path.isabs(value) else os.path.abspath(os.path.join(base_dir, value))

    settings = {
        'srt_dir': resolve('SRT_DIR'),
        'streamable_dir': resolve('STREAMABLE_DIR'),
        'port': int(raw.get('PORT') or PORT),
        'log_dir': resolve('LOG_DIR'),
        'selected': raw.get('SELECTED', '')
    }
    configure(settings)


def load_from_file(path: str):
    """Load config from a JSON file (used when running outside Colab)."""
    with open(path) as f:
        settings = json.load(f)

    base_dir = os.path.dirname(os.path.abspath(path))
    if settings.get('srt_dir') and not os.path.isabs(settings['srt_dir']):
        settings['srt_dir'] = os.path.abspath(os.path.join(base_dir, settings['srt_dir']))
    if settings.get('streamable_dir') and not os.path.isabs(settings['streamable_dir']):
        settings['streamable_dir'] = os.path.abspath(os.path.join(base_dir, settings['streamable_dir']))
    if settings.get('log_dir') and not os.path.isabs(settings['log_dir']):
        settings['log_dir'] = os.path.abspath(os.path.join(base_dir, settings['log_dir']))

    configure(settings)


def list_srt_files():
    """Return sorted list of .srt filenames in SRT_DIR."""
    if not SRT_DIR or not os.path.exists(SRT_DIR):
        return []
    return sorted(f for f in os.listdir(SRT_DIR) if f.endswith('.srt'))
