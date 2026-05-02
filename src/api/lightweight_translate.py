"""
Transcribblr — Lightweight translation
HTTP-based fallback used by /context-edit for single character / vocab /
description edits where loading C3TR (Gemma-2-9B) would be wasteful AND
contend with Whisper/Qwen for VRAM.

Heavy / batch pipelines (build_context, Translations Basic) still go
through context.py's C3TR-backed translate functions. This module is
strictly for short, infrequent strings.

Backed by deep-translator's GoogleTranslator (no API key, free, but
rate-limited if called rapidly). Falls back to passing the input through
unchanged if the network is unreachable so the user can still save edits.
"""

from logger import log


def _is_japanese(text: str) -> bool:
    import unicodedata
    return any(
        unicodedata.name(c, '').startswith(('CJK', 'HIRAGANA', 'KATAKANA'))
        for c in text
    )


def _translate(text: str, source: str, target: str) -> str:
    text = (text or '').strip()
    if not text:
        return ''
    try:
        from deep_translator import GoogleTranslator
    except ImportError:
        log.warning('deep-translator not installed — returning input unchanged')
        return text
    try:
        return GoogleTranslator(source=source, target=target).translate(text) or text
    except Exception as e:
        log.warning(f'lightweight translate failed ({source}→{target}): {e}')
        return text


def translate_to_japanese(text: str) -> str:
    """English → Japanese. Returns input unchanged if already Japanese or
    if the network call fails."""
    if not text or not text.strip():
        return ''
    if _is_japanese(text):
        return text.strip()
    return _translate(text, source='en', target='ja')


def translate_to_english(text: str) -> str:
    """Japanese → English. Returns input unchanged if already English or
    if the network call fails."""
    if not text or not text.strip():
        return ''
    if not _is_japanese(text):
        return text.strip()
    return _translate(text, source='ja', target='en')


def translate_list_to_japanese(items: list) -> list:
    return [translate_to_japanese(i) for i in (items or [])]


def translate_list_to_english(items: list) -> list:
    return [translate_to_english(i) for i in (items or [])]
