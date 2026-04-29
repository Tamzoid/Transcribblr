"""
Tests for configuration loading (config.py)
"""
import sys
import json
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "api"))


class TestEnvFileParsing:
    """Tests for parsing .env files"""

    def test_parse_env_file(self, temp_dir):
        """Parse a .env file"""
        import config
        
        env_file = temp_dir / ".env"
        env_file.write_text(
            "PORT=8080\n"
            "DATA_PATH=/path/to/data\n"
            "# Comment line\n"
            "LOG_DIR=/var/log\n"
        )
        
        result = config._parse_env_file(str(env_file))
        assert result['PORT'] == '8080'
        assert result['DATA_PATH'] == '/path/to/data'
        assert result['LOG_DIR'] == '/var/log'
        assert '# Comment line' not in str(result)

    def test_parse_env_file_quoted_values(self, temp_dir):
        """Parse .env with quoted values"""
        import config
        
        env_file = temp_dir / ".env"
        env_file.write_text(
            'PATH="/some/path"\n'
            "NAME='quoted'\n"
        )
        
        result = config._parse_env_file(str(env_file))
        assert result['PATH'] == '/some/path'
        assert result['NAME'] == 'quoted'

    def test_parse_env_file_empty(self, temp_dir):
        """Parse empty .env file"""
        import config
        
        env_file = temp_dir / ".env"
        env_file.write_text("")
        
        result = config._parse_env_file(str(env_file))
        assert result == {}


class TestConfigLoading:
    """Tests for loading configuration"""

    def test_load_from_env(self, temp_dir):
        """Load configuration from .env file"""
        import config
        
        env_file = temp_dir / ".env"
        srt_dir = temp_dir / "subtitles"
        audio_dir = temp_dir / "audio"
        srt_dir.mkdir()
        audio_dir.mkdir()
        
        env_file.write_text(
            f"SRT_DIR={srt_dir}\n"
            f"STREAMABLE_DIR={audio_dir}\n"
            "PORT=9000\n"
        )
        
        config.load_from_env(str(env_file))
        
        assert config.PORT == 9000
        assert config.SRT_DIR == str(srt_dir)
        assert config.STREAMABLE_DIR == str(audio_dir)

    def test_load_from_env_relative_paths(self, temp_dir):
        """Load .env with relative paths"""
        import config
        
        env_file = temp_dir / ".env"
        env_file.write_text(
            "SRT_DIR=./subtitles\n"
            "STREAMABLE_DIR=./audio\n"
            "PORT=8765\n"
        )
        
        config.load_from_env(str(env_file))
        
        assert config.PORT == 8765
        # Relative paths should be absolute
        assert str(temp_dir) in config.SRT_DIR
        assert str(temp_dir) in config.STREAMABLE_DIR

    def test_load_from_env_missing_file(self):
        """Load from missing .env raises error"""
        import config
        
        with pytest.raises(FileNotFoundError):
            config.load_from_env("/nonexistent/.env")

    def test_load_from_file_json(self, temp_dir):
        """Load configuration from JSON file"""
        import config
        
        srt_dir = temp_dir / "subtitles"
        audio_dir = temp_dir / "audio"
        srt_dir.mkdir()
        audio_dir.mkdir()
        
        config_file = temp_dir / "config.json"
        config_file.write_text(json.dumps({
            "srt_dir": str(srt_dir),
            "streamable_dir": str(audio_dir),
            "port": 7777,
            "log_dir": "",
        }))
        
        config.load_from_file(str(config_file))
        
        assert config.PORT == 7777
        assert config.SRT_DIR == str(srt_dir)

    def test_configure_creates_srt_dir(self, temp_dir):
        """configure() creates SRT directory if needed"""
        import config
        
        srt_dir = temp_dir / "new_subtitles"
        assert not srt_dir.exists()
        
        config.configure({
            'srt_dir': str(srt_dir),
            'streamable_dir': '',
            'port': 8765,
        })
        
        assert srt_dir.exists()

    def test_list_srt_files(self, temp_dir):
        """List .srt files in configured directory"""
        import config
        
        srt_dir = temp_dir / "subtitles"
        srt_dir.mkdir()
        (srt_dir / "file1.srt").touch()
        (srt_dir / "file2.srt").touch()
        (srt_dir / "file3.txt").touch()  # Should be ignored
        
        config.SRT_DIR = str(srt_dir)
        
        files = config.list_srt_files()
        assert len(files) == 2
        assert "file1.srt" in files
        assert "file2.srt" in files
        assert "file3.txt" not in files
        assert files == sorted(files)  # Should be sorted
