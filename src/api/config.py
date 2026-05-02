"""
Transcribblr — Config
Loads settings and holds mutable runtime state (selected file, audio paths).
"""

import os
import json
import threading
from logger import log

# ── Paths (resolved at runtime by configure()) ────────────────────────────────

DATA_PATH       = ''
SRT_DIR         = ''
STREAMABLE_DIR  = ''
INPUT_DIR       = ''
CONVERTED_DIR   = ''
PROJECTS_DIR    = ''
VOCALS_DIR      = ''
MODEL_CACHE_DIR = ''   # where translate_advanced.py caches the Qwen weights
PORT            = 8765
LOG_DIR         = ''

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
    global DATA_PATH, SRT_DIR, STREAMABLE_DIR, INPUT_DIR, CONVERTED_DIR, PROJECTS_DIR, VOCALS_DIR, MODEL_CACHE_DIR, PORT, LOG_DIR

    data = settings.get('data_path', '')
    DATA_PATH      = data
    SRT_DIR        = os.path.join(data, 'subtitles')
    STREAMABLE_DIR = os.path.join(data, 'audio')
    INPUT_DIR      = os.path.join(data, 'input')
    CONVERTED_DIR  = os.path.join(data, 'audio_converted')
    PROJECTS_DIR   = os.path.join(data, 'projects')
    VOCALS_DIR     = os.path.join(data, 'vocals')
    # Big model weights live next to the data dir so they survive across
    # projects but stay in user-managed Drive (not /tmp). Override via
    # MODEL_CACHE_DIR in .env if you want a different location.
    MODEL_CACHE_DIR = settings.get('model_cache_dir') or os.path.join(
        os.path.dirname(data) if data else '.', 'model_cache'
    )
    PORT           = settings.get('port', 8765)
    LOG_DIR        = settings.get('log_dir', '')

    for d in (SRT_DIR, INPUT_DIR, CONVERTED_DIR, PROJECTS_DIR, VOCALS_DIR, MODEL_CACHE_DIR):
        os.makedirs(d, exist_ok=True)

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
        'data_path': resolve('DATA_PATH'),
        'port': int(raw.get('PORT') or PORT),
        'log_dir': resolve('LOG_DIR'),
        'model_cache_dir': resolve('MODEL_CACHE_DIR'),
        'selected': raw.get('SELECTED', '')
    }
    configure(settings)


def load_from_file(path: str):
    """Load config from a JSON file (used when running outside Colab)."""
    with open(path) as f:
        settings = json.load(f)

    base_dir = os.path.dirname(os.path.abspath(path))
    def _abs(key):
        v = settings.get(key, '')
        if v and not os.path.isabs(v):
            settings[key] = os.path.abspath(os.path.join(base_dir, v))
    _abs('data_path')
    _abs('log_dir')

    configure(settings)


def list_srt_files():
    """Return sorted list of .srt filenames in SRT_DIR."""
    if not SRT_DIR or not os.path.exists(SRT_DIR):
        return []
    return sorted(f for f in os.listdir(SRT_DIR) if f.endswith('.srt'))
