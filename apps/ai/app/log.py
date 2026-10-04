import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

from tracing.masking import Masker

# Logs get the same masking as traces (A8.3), by key and by shape. There are no HR records
# here to learn names from, so names aren't masked: code never logs them in the first place.
_MASKER = Masker()


class JsonFormatter(logging.Formatter):
    """One JSON object per line. Structured fields go in `extra={"fields": {...}}`.
    Credentials and personal data are masked before the line is written."""

    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "event": _MASKER.mask(record.getMessage()),
        }
        fields: dict[str, Any] | None = getattr(record, "fields", None)
        if fields:
            line.update(_MASKER.mask(fields))
        if record.exc_info:
            line["exc"] = _MASKER.mask(self.formatException(record.exc_info))
        return json.dumps(line, default=str)


def configure_logging(level: str = "INFO") -> None:
    """JSON logs to stderr for our loggers (hr_ai.*); leaves uvicorn's own logging alone."""
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger("hr_ai")
    root.handlers = [handler]
    root.setLevel(level)
    root.propagate = False
