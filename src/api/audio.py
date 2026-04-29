"""
Transcribblr — Audio
Looks up pre-converted streamable audio files and manages the active file state.
"""

import os
import config
from logger import log


# Mapping of player source key → "{suffix}{ext}" relative to STREAMABLE_DIR
SOURCE_FILES = {
    'vocals': '.vocals.m4a',
    'full':   '.full.m4a',
    'video':  '.video.mp4',
}


def find_streamable(stem: str, suffix: str = None, src_key: str = None) -> str:
    """
    Look up a pre-converted streamable file. Returns the path if it exists.

    Either:
      - src_key='vocals'|'full'|'video' (preferred), or
      - suffix='.vocals' for legacy callers (defaults to .m4a extension).
    """
    if not config.STREAMABLE_DIR:
        return ''
    if src_key:
        rel = SOURCE_FILES.get(src_key)
        if not rel:
            return ''
    else:
        rel = (suffix or '') + '.m4a'
    p = os.path.join(config.STREAMABLE_DIR, stem + rel)
    found = os.path.exists(p)
    log.debug(f"Streamable lookup: {os.path.basename(p)} → {'found' if found else 'not found'}")
    return p if found else ''


def load_file(name: str):
    """
    Switch the active project file.
    Looks up available audio + video sources and updates config.state.
    Raises ValueError if neither a project JSON nor a legacy SRT file exists.
    """
    stem = os.path.splitext(name)[0]
    project_path = os.path.join(config.PROJECTS_DIR, stem + '.json') if config.PROJECTS_DIR else ''
    srt_path = os.path.join(config.SRT_DIR, name) if config.SRT_DIR else ''
    if not (project_path and os.path.exists(project_path)) and \
       not (srt_path and os.path.exists(srt_path)):
        raise ValueError(f"'{name}' not found")

    audio_paths = {k: find_streamable(stem, src_key=k) for k in SOURCE_FILES}

    with config.state_lock:
        config.state['selected']    = name
        config.state['audio_paths'] = audio_paths
        config.state['audio_path']  = audio_paths['vocals'] or audio_paths['full']

    available = [k for k, v in audio_paths.items() if v]
    log.info(f"Active file: {name} | Sources: {available or 'none'}")
