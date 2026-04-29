"""
Tests for SRT file handling (srt.py)
"""
import pytest
import sys
from pathlib import Path

# Import after path is set in conftest
sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "api"))
import srt


class TestTimeConversion:
    """Tests for time conversion functions"""

    def test_to_sec_from_timestamp(self):
        """Convert SRT timestamp to seconds"""
        assert srt.to_sec("00:00:05,000") == 5.0
        assert srt.to_sec("00:01:00,000") == 60.0
        assert srt.to_sec("01:00:00,000") == 3600.0
        assert srt.to_sec("00:00:00,500") == 0.5

    def test_to_sec_from_number(self):
        """Convert number to seconds"""
        assert srt.to_sec(5) == 5.0
        assert srt.to_sec(3.5) == 3.5
        assert srt.to_sec(0) == 0.0

    def test_to_sec_invalid(self):
        """Invalid timestamp returns 0"""
        assert srt.to_sec("invalid") == 0.0
        assert srt.to_sec("") == 0.0

    def test_to_ts_from_seconds(self):
        """Convert seconds to SRT timestamp"""
        assert srt.to_ts(0.0) == "00:00:00,000"
        assert srt.to_ts(5.0) == "00:00:05,000"
        assert srt.to_ts(65.5) == "00:01:05,500"
        assert srt.to_ts(3661.0) == "01:01:01,000"

    def test_to_ts_negative(self):
        """Negative seconds are clamped to 0"""
        assert srt.to_ts(-5.0) == "00:00:00,000"

    def test_timestamp_roundtrip(self):
        """to_sec and to_ts are inverse operations"""
        original = 125.375
        timestamp = srt.to_ts(original)
        result = srt.to_sec(timestamp)
        assert abs(result - original) < 0.001


class TestSRTLoading:
    """Tests for loading SRT files"""

    def test_load_srt_success(self, sample_srt_path):
        """Load a valid SRT file"""
        entries = srt.load_srt(str(sample_srt_path))
        assert len(entries) == 3
        
        # Check first entry
        assert entries[0]['start'] == 0.0
        assert entries[0]['end'] == 5.0
        assert entries[0]['text'] == "First subtitle"
        
        # Check second entry (multiline)
        assert entries[1]['start'] == 5.0
        assert entries[1]['end'] == 10.0
        assert "Second subtitle" in entries[1]['text']
        assert "multiple lines" in entries[1]['text']

    def test_load_srt_nonexistent(self):
        """Load nonexistent file returns empty list"""
        entries = srt.load_srt("/nonexistent/file.srt")
        assert entries == []

    def test_load_srt_empty(self, temp_dir):
        """Load empty SRT file"""
        empty_srt = temp_dir / "empty.srt"
        empty_srt.write_text("", encoding='utf-8')
        entries = srt.load_srt(str(empty_srt))
        assert entries == []


class TestSRTWriting:
    """Tests for writing SRT files"""

    def test_write_srt_success(self, temp_dir):
        """Write entries to SRT file"""
        entries = [
            {'start': 0.0, 'end': 5.0, 'text': 'First'},
            {'start': 5.0, 'end': 10.0, 'text': 'Second'},
        ]
        output_path = temp_dir / "output.srt"
        
        srt.write_srt(entries, str(output_path))
        
        assert output_path.exists()
        content = output_path.read_text(encoding='utf-8')
        assert "00:00:00,000 --> 00:00:05,000" in content
        assert "First" in content
        assert "Second" in content

    def test_write_and_load_roundtrip(self, temp_dir):
        """Write and read back entries"""
        original_entries = [
            {'start': 1.5, 'end': 5.75, 'text': 'Hello'},
            {'start': 10.0, 'end': 15.5, 'text': 'World'},
        ]
        output_path = temp_dir / "roundtrip.srt"
        
        srt.write_srt(original_entries, str(output_path))
        loaded_entries = srt.load_srt(str(output_path))
        
        assert len(loaded_entries) == len(original_entries)
        for orig, loaded in zip(original_entries, loaded_entries):
            assert abs(loaded['start'] - orig['start']) < 0.01
            assert abs(loaded['end'] - orig['end']) < 0.01
            assert loaded['text'] == orig['text']

    def test_write_empty_list(self, temp_dir):
        """Write empty list creates file"""
        output_path = temp_dir / "empty_output.srt"
        srt.write_srt([], str(output_path))

        assert output_path.exists()
        assert output_path.read_text(encoding='utf-8') == ""


class TestSRTEdgeCases:
    """Tests for malformed or unusual SRT content"""

    def test_malformed_block_skipped(self, temp_dir):
        """Blocks without a valid --> line are silently skipped"""
        bad_srt = temp_dir / "bad.srt"
        bad_srt.write_text(
            "1\nNOT A TIMESTAMP\nsome text\n\n"
            "2\n00:00:05,000 --> 00:00:10,000\nGood subtitle\n",
            encoding='utf-8',
        )
        entries = srt.load_srt(str(bad_srt))
        assert len(entries) == 1
        assert entries[0]['text'] == 'Good subtitle'

    def test_block_with_no_text_gives_empty_string(self, temp_dir):
        """A block with only an index and timestamp produces empty text"""
        no_text_srt = temp_dir / "notext.srt"
        no_text_srt.write_text(
            "1\n00:00:00,000 --> 00:00:05,000\n",
            encoding='utf-8',
        )
        entries = srt.load_srt(str(no_text_srt))
        assert len(entries) == 1
        assert entries[0]['text'] == ''

    def test_windows_line_endings(self, temp_dir):
        """CRLF line endings are handled correctly"""
        crlf_srt = temp_dir / "crlf.srt"
        crlf_srt.write_bytes(
            b"1\r\n00:00:00,000 --> 00:00:05,000\r\nHello\r\n"
        )
        entries = srt.load_srt(str(crlf_srt))
        assert len(entries) == 1
        assert entries[0]['text'] == 'Hello'

    def test_multiple_malformed_mixed_with_good(self, temp_dir):
        """Only valid blocks survive; malformed ones are silently dropped"""
        mixed = temp_dir / "mixed.srt"
        mixed.write_text(
            "1\nBAD\ntext\n\n"
            "2\n00:00:01,000 --> 00:00:02,000\nGood\n\n"
            "3\nalso bad\n\n"
            "4\n00:00:03,000 --> 00:00:04,000\nAlso good\n",
            encoding='utf-8',
        )
        entries = srt.load_srt(str(mixed))
        assert len(entries) == 2
        assert entries[0]['text'] == 'Good'
        assert entries[1]['text'] == 'Also good'
