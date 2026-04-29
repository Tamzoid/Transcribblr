"""
Shared test configuration and fixtures
"""
import os
import sys
import tempfile
from pathlib import Path

import pytest

# Add src/api to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "api"))


@pytest.fixture(autouse=True)
def reset_config():
    """Restore config globals and state after every test to prevent cross-test pollution."""
    import config
    saved = {
        'SRT_DIR':        config.SRT_DIR,
        'STREAMABLE_DIR': config.STREAMABLE_DIR,
        'PORT':           config.PORT,
        'LOG_DIR':        config.LOG_DIR,
        'selected':       config.state['selected'],
        'audio_paths':    dict(config.state['audio_paths']),
        'audio_path':     config.state['audio_path'],
    }
    yield
    config.SRT_DIR        = saved['SRT_DIR']
    config.STREAMABLE_DIR = saved['STREAMABLE_DIR']
    config.PORT           = saved['PORT']
    config.LOG_DIR        = saved['LOG_DIR']
    config.state['selected']    = saved['selected']
    config.state['audio_paths'] = saved['audio_paths']
    config.state['audio_path']  = saved['audio_path']


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files"""
    with tempfile.TemporaryDirectory() as tmp_dir:
        yield Path(tmp_dir)


@pytest.fixture
def sample_srt_path(temp_dir):
    """Create a sample SRT file"""
    srt_content = """1
00:00:00,000 --> 00:00:05,000
First subtitle

2
00:00:05,000 --> 00:00:10,000
Second subtitle
with multiple lines

3
00:00:10,000 --> 00:00:15,000
Third subtitle
"""
    path = temp_dir / "sample.srt"
    path.write_text(srt_content, encoding='utf-8')
    return path


@pytest.fixture
def sample_audio_dir(temp_dir):
    """Create a temporary directory with sample audio files"""
    audio_dir = temp_dir / "audio"
    audio_dir.mkdir()
    
    # Create dummy audio files
    (audio_dir / "episode01.vocals.m4a").touch()
    (audio_dir / "episode01.full.m4a").touch()
    (audio_dir / "episode02.vocals.m4a").touch()
    
    return audio_dir
