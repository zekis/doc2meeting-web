"""Background worker for review + TTS job processing.

Polls Redis for queued jobs and processes them. Currently a stub that
keeps the container alive — actual job dispatch will be wired in as
the job queue is implemented.
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import time

from .logging_config import setup_logging

setup_logging()

logger = logging.getLogger("worker")

_running = True


def _shutdown(signum, frame):
    global _running
    logger.info("Received signal %s, shutting down...", signum)
    _running = False


def main() -> None:
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    redis_url = os.environ.get("REDIS_URL")
    logger.info("Worker starting (REDIS_URL=%s)", "set" if redis_url else "unset")

    while _running:
        # Placeholder: poll Redis for jobs once queue is implemented
        time.sleep(5)

    logger.info("Worker stopped.")


if __name__ == "__main__":
    main()
