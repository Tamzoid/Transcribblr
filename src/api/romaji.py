"""
Transcribblr — Romaji
Cutlet-based Japanese → romaji conversion with in-memory cache.
"""

from logger import log

_cache: dict = {}
_cutlet = None
available = False


def _init():
    global _cutlet, available
    try:
        import cutlet
        _cutlet = cutlet.Cutlet(ensure_ascii=False)
        _cutlet.use_foreign_spelling = False
        available = True
        log.info("Cutlet loaded — romaji enabled")
    except ImportError:
        available = False
        log.warning("Cutlet not installed — romaji disabled")


_init()


def convert(text: str) -> str:
    """
    Convert Japanese text to romaji.
    Returns empty string if cutlet is not available.
    Results are cached in memory.
    """
    if not available or not text:
        return ''
    if text not in _cache:
        try:
            _cache[text] = _cutlet.romaji(text)
            log.debug(f"Romaji: '{text[:30]}' → '{_cache[text][:30]}'")
        except Exception as e:
            log.error(f"Romaji conversion failed: {e}")
            _cache[text] = ''
    return _cache[text]


def cache_size() -> int:
    return len(_cache)
