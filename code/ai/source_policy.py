"""Minimize source data sent to an explicitly selected model."""
import json
from pathlib import Path
import re
from urllib.request import HTTPRedirectHandler

_RULES = json.loads(Path(__file__).with_name("source_policy.json").read_text(encoding="utf-8"))
_PATH = re.compile(_RULES["sensitive_path"], re.I)
_TEXT = tuple(re.compile(pattern, re.I | re.M) for pattern in _RULES["sensitive_text"])
CONSENT_MESSAGE = "请先确认允许向所选模型服务发送处理后的源码。"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require_source_consent(payload):
    if not isinstance(payload, dict) or payload.get("source_consent") is not True:
        raise ValueError(CONSENT_MESSAGE)


def shareable_path(path):
    normalized = path.replace("\\", "/")
    return (not normalized.startswith("/") and ":" not in normalized
            and ".." not in normalized.split("/") and not _PATH.search(normalized))


def redact_model_text(text, key=""):
    if len(key) >= 8:
        text = text.replace(key, "[REDACTED]")
    for pattern in _TEXT:
        text = pattern.sub(_placeholder, text)
    return text


def _placeholder(match):
    text = match[0]
    prefix = text[0] if text[0] in " \t\"'\n\r(=" else ""
    return prefix + re.sub(r"[^\r\n]+", "[REDACTED]", text[len(prefix):])
