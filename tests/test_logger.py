"""
Tests for logger module (logger.py)
"""
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "api"))


class TestLogBuffer:

    def test_get_recent_logs_returns_list(self):
        from logger import get_recent_logs
        assert isinstance(get_recent_logs(), list)

    def test_logged_message_appears_in_buffer(self):
        from logger import get_logger, get_recent_logs, _log_buffer
        _log_buffer.clear()
        lg = get_logger('test_appears')
        lg.debug("sentinel_msg_12345")
        messages = [e['message'] for e in get_recent_logs()]
        assert any("sentinel_msg_12345" in m for m in messages)

    def test_buffer_entry_has_required_fields(self):
        from logger import get_logger, get_recent_logs, _log_buffer
        _log_buffer.clear()
        lg = get_logger('test_fields')
        lg.info("field check")
        entry = get_recent_logs()[-1]
        assert {'time', 'level', 'module', 'message'} <= entry.keys()

    def test_buffer_records_correct_level(self):
        from logger import get_logger, get_recent_logs, _log_buffer
        _log_buffer.clear()
        lg = get_logger('test_level')
        lg.warning("warning sentinel")
        entries = [e for e in get_recent_logs() if "warning sentinel" in e['message']]
        assert entries and entries[0]['level'] == 'WARNING'

    def test_buffer_max_size_is_500(self):
        from logger import _log_buffer
        assert _log_buffer.maxlen == 500

    def test_buffer_does_not_grow_beyond_maxlen(self):
        from logger import get_logger, _log_buffer
        _log_buffer.clear()
        lg = get_logger('test_overflow')
        for i in range(600):
            lg.debug(f"overflow {i}")
        assert len(_log_buffer) == 500


class TestGetLogger:

    def test_returns_logging_logger(self):
        from logger import get_logger
        assert isinstance(get_logger('ret_test'), logging.Logger)

    def test_logger_level_is_debug(self):
        from logger import get_logger
        lg = get_logger('level_test')
        assert lg.level == logging.DEBUG

    def test_logger_does_not_propagate(self):
        from logger import get_logger
        assert get_logger('prop_test').propagate is False

    def test_logger_has_handlers(self):
        from logger import get_logger
        lg = get_logger('handler_test')
        assert len(lg.handlers) > 0

    def test_logger_with_log_dir_creates_directory(self, temp_dir):
        from logger import get_logger
        log_dir = str(temp_dir / "logs")
        lg = get_logger('dir_test', log_dir=log_dir)
        try:
            assert Path(log_dir).exists()
        finally:
            for h in lg.handlers:
                h.close()

    def test_logger_with_log_dir_has_rotating_handler(self, temp_dir):
        from logger import get_logger
        from logging.handlers import RotatingFileHandler
        lg = get_logger('rot_test', log_dir=str(temp_dir / "rlogs"))
        try:
            assert RotatingFileHandler in [type(h) for h in lg.handlers]
        finally:
            for h in lg.handlers:
                h.close()

    def test_logger_without_log_dir_has_no_file_handler(self):
        from logger import get_logger
        from logging.handlers import RotatingFileHandler
        lg = get_logger('no_file_test')
        assert not any(isinstance(h, RotatingFileHandler) for h in lg.handlers)

    def test_logger_has_stream_handler(self):
        from logger import get_logger
        lg = get_logger('stream_test')
        assert any(type(h) is logging.StreamHandler for h in lg.handlers)

    def test_reinitialising_same_name_clears_old_handlers(self):
        from logger import get_logger
        lg1 = get_logger('reuse_test')
        count_after_first = len(lg1.handlers)
        lg2 = get_logger('reuse_test')
        # Handlers should be reset, not doubled
        assert len(lg2.handlers) == count_after_first
