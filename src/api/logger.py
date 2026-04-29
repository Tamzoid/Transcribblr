"""
Transcribblr — Logger
Writes to console, rotating log file, and an in-memory buffer for /logs endpoint.
"""

import logging
import os
import collections
from logging.handlers import RotatingFileHandler

# ── In-memory ring buffer for /logs endpoint ──────────────────────────────────
_log_buffer = collections.deque(maxlen=500)

class _BufferHandler(logging.Handler):
    def emit(self, record):
        _log_buffer.append({
            'time':    self.formatter.formatTime(record, '%H:%M:%S'),
            'level':   record.levelname,
            'module':  record.module,
            'message': record.getMessage(),
        })

def get_recent_logs():
    return list(_log_buffer)


# ── Logger factory ─────────────────────────────────────────────────────────────

def get_logger(name='transcribblr', log_dir=None):
    logger = logging.getLogger(name)
    logger.propagate = False
    # Clear any stale handlers from previous runs (logging registry persists across reimports)
    logger.handlers.clear()

    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    fmt = logging.Formatter('%(asctime)s [%(levelname)s] %(module)s: %(message)s',
                            datefmt='%H:%M:%S')

    # Console
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(fmt)
    logger.addHandler(ch)

    # Rotating file (if log_dir provided)
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)
        fh = RotatingFileHandler(
            os.path.join(log_dir, 'transcribblr.log'),
            maxBytes=1_000_000,  # 1MB per file
            backupCount=3,
            encoding='utf-8',
        )
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(fmt)
        logger.addHandler(fh)

    # In-memory buffer
    bh = _BufferHandler()
    bh.setLevel(logging.DEBUG)
    bh.setFormatter(fmt)
    logger.addHandler(bh)

    return logger


# Module-level default logger — callers can use this directly
log = get_logger()
