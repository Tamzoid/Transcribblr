"""
Transcribblr — Audio
Looks up pre-converted streamable audio files and manages the active file state.
"""

import os
import config
from logger import log


def find_streamable(stem: str, suffix: str) -> str:
    """
    Look up a pre-converted .m4a in the streamable directory.
    Returns the path if it exists, empty string otherwise.
    Expected filename format: {stem}{suffix}.m4a  e.g. episode01.vocals.m4a
    """
    if not config.STREAMABLE_DIR:
        return ''
    p = os.path.join(config.STREAMABLE_DIR, stem + suffix + '.m4a')
    found = os.path.exists(p)
    log.debug(f"Audio lookup: {os.path.basename(p)} → {'found' if found else 'not found'}")
    return p if found else ''


def load_file(name: str):
    """
    Switch the active SRT file.
    Looks up available audio sources and updates config.state.
    Raises ValueError if the file doesn't exist in SRT_DIR.
    """
    srt_files = config.list_srt_files()
    if name not in srt_files:
        raise ValueError(f"'{name}' not found in {config.SRT_DIR}")

    stem = os.path.splitext(name)[0]
    audio_paths = {
        'vocals': find_streamable(stem, '.vocals'),
        'full':   find_streamable(stem, '.full'),
    }

    with config.state_lock:
        config.state['selected']    = name
        config.state['audio_paths'] = audio_paths
        config.state['audio_path']  = audio_paths['vocals'] or audio_paths['full']

    available = [k for k, v in audio_paths.items() if v]
    log.info(f"Active file: {name} | Audio: {available or 'none'}")
