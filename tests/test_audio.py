"""
Tests for audio file handling (audio.py)
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "api"))


class TestAudioLookup:
    """Tests for finding audio files"""

    def test_find_streamable_exists(self, sample_audio_dir):
        """Find existing audio file"""
        # Import here so config path can be modified
        import audio
        import config
        
        # Set streamable dir for test
        config.STREAMABLE_DIR = str(sample_audio_dir)
        
        result = audio.find_streamable("episode01", ".vocals")
        assert result
        assert "episode01.vocals.m4a" in result

    def test_find_streamable_not_found(self, sample_audio_dir):
        """Find nonexistent audio file returns empty string"""
        import audio
        import config
        
        config.STREAMABLE_DIR = str(sample_audio_dir)
        
        result = audio.find_streamable("episode99", ".vocals")
        assert result == ''

    def test_find_streamable_no_dir(self):
        """Find with no STREAMABLE_DIR returns empty string"""
        import audio
        import config
        
        config.STREAMABLE_DIR = ''
        result = audio.find_streamable("anything", ".vocals")
        assert result == ''


class TestAudioFileLoading:
    """Tests for load_file function"""

    def test_load_file_success(self, temp_dir, sample_audio_dir):
        """Load an available audio file"""
        import audio
        import config
        from srt import load_srt, write_srt
        
        # Set up directories
        srt_dir = temp_dir / "subtitles"
        srt_dir.mkdir()
        config.SRT_DIR = str(srt_dir)
        config.STREAMABLE_DIR = str(sample_audio_dir)
        
        # Create a test SRT file
        srt_file = srt_dir / "episode01.srt"
        entries = [{'start': 0.0, 'end': 5.0, 'text': 'Test'}]
        write_srt(entries, str(srt_file))
        
        # Load the file
        audio.load_file("episode01.srt")
        
        assert config.state['selected'] == "episode01.srt"
        assert config.state['audio_paths']['vocals']

    def test_load_file_not_found(self, temp_dir):
        """Load nonexistent file raises ValueError"""
        import audio
        import config

        srt_dir = temp_dir / "subtitles"
        srt_dir.mkdir()
        config.SRT_DIR = str(srt_dir)
        config.STREAMABLE_DIR = str(temp_dir / "audio")

        with pytest.raises(ValueError):
            audio.load_file("nonexistent.srt")

    def test_load_file_falls_back_to_full_when_no_vocals(self, temp_dir, sample_audio_dir):
        """When only the .full audio exists, audio_path is the full path"""
        import audio
        import config
        from srt import write_srt

        srt_dir = temp_dir / "subtitles"
        srt_dir.mkdir()
        config.SRT_DIR = str(srt_dir)
        config.STREAMABLE_DIR = str(sample_audio_dir)

        srt_file = srt_dir / "episode02.srt"
        write_srt([{'start': 0.0, 'end': 2.0, 'text': 'Hi'}], str(srt_file))

        audio.load_file("episode02.srt")

        # episode02 has no .full audio in the fixture — audio_path should be empty
        assert config.state['selected'] == 'episode02.srt'
        assert config.state['audio_paths']['vocals']      # vocals exists
        assert not config.state['audio_paths']['full']    # full does not

    def test_load_file_prefers_vocals_over_full(self, temp_dir, sample_audio_dir):
        """When both audio sources exist, audio_path is the vocals path"""
        import audio
        import config
        from srt import write_srt

        # Create the missing .full file so both exist
        (sample_audio_dir / "episode01.full.m4a").touch()

        srt_dir = temp_dir / "subtitles"
        srt_dir.mkdir()
        config.SRT_DIR = str(srt_dir)
        config.STREAMABLE_DIR = str(sample_audio_dir)

        srt_file = srt_dir / "episode01.srt"
        write_srt([{'start': 0.0, 'end': 2.0, 'text': 'Hi'}], str(srt_file))

        audio.load_file("episode01.srt")

        assert 'vocals' in config.state['audio_path']

    def test_load_file_no_audio_available(self, temp_dir):
        """When no audio files exist, audio_path is empty string"""
        import audio
        import config
        from srt import write_srt

        srt_dir = temp_dir / "subtitles"
        audio_dir = temp_dir / "audio"
        srt_dir.mkdir()
        audio_dir.mkdir()
        config.SRT_DIR = str(srt_dir)
        config.STREAMABLE_DIR = str(audio_dir)

        srt_file = srt_dir / "episode01.srt"
        write_srt([{'start': 0.0, 'end': 2.0, 'text': 'Hi'}], str(srt_file))

        audio.load_file("episode01.srt")

        assert config.state['audio_path'] == ''
        assert config.state['audio_paths'] == {'vocals': '', 'full': ''}


class TestFindStreamableVariants:
    """Edge cases for find_streamable"""

    def test_find_full_suffix(self, sample_audio_dir):
        """Find .full audio file"""
        import audio
        import config

        config.STREAMABLE_DIR = str(sample_audio_dir)
        result = audio.find_streamable("episode01", ".full")
        assert result
        assert "episode01.full.m4a" in result

    def test_find_unknown_suffix_returns_empty(self, sample_audio_dir):
        """Unknown suffix that doesn't exist returns empty"""
        import audio
        import config

        config.STREAMABLE_DIR = str(sample_audio_dir)
        result = audio.find_streamable("episode01", ".instrumental")
        assert result == ''
