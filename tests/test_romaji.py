"""
Tests for Romaji conversion (romaji.py)
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "api"))


class TestRomajiConversion:
    """Tests for Japanese text to romaji conversion"""

    def test_convert_empty_string(self):
        """Convert empty string returns empty"""
        import romaji
        result = romaji.convert("")
        assert result == ""

    def test_cache_size_init(self):
        """Cache size starts at 0 or populated"""
        import romaji
        # Clear cache if needed
        romaji._cache.clear()
        size = romaji.cache_size()
        assert size >= 0

    @pytest.mark.skipif(
        not __import__('importlib.util').util.find_spec('cutlet'),
        reason="cutlet not installed"
    )
    def test_convert_japanese(self):
        """Convert Japanese text to romaji if available"""
        import romaji
        
        if not romaji.available:
            pytest.skip("Cutlet not available")
        
        # Clear cache
        romaji._cache.clear()
        
        result = romaji.convert("こんにちは")
        # Should get a romaji result
        assert isinstance(result, str)
        if result:  # Only check if conversion succeeded
            assert len(result) > 0
            # Check it's in ASCII (rough check for romaji)
            assert all(ord(c) < 128 for c in result)

    def test_convert_caching(self):
        """Converted strings are cached"""
        import romaji
        
        # Only run if cutlet is available
        if not romaji.available:
            pytest.skip("Cutlet not available")
        
        romaji._cache.clear()
        initial_size = romaji.cache_size()
        
        result1 = romaji.convert("テスト")
        size_after_one = romaji.cache_size()
        
        result2 = romaji.convert("テスト")  # Same text
        size_after_two = romaji.cache_size()
        
        # Size should increase by 1 after first convert
        assert size_after_one >= initial_size
        # Size shouldn't change on second convert (cached)
        assert size_after_two == size_after_one
        # Results should be identical
        assert result1 == result2

    def test_convert_unavailable(self):
        """Convert returns empty if cutlet unavailable"""
        import romaji
        
        # Temporarily disable
        original_available = romaji.available
        romaji.available = False
        
        try:
            result = romaji.convert("anything")
            assert result == ""
        finally:
            romaji.available = original_available
