"""
Cloudflare R2 temp uploads for Studio video references.

Seedance 2.0 requires `reference_video` to be a public web URL (it rejects
base64), so a locally-uploaded reference video has to be hosted somewhere
Seedance's servers can fetch. We upload it to an R2 bucket under a `studio-temp/`
prefix, hand the public URL to Seedance, and delete the object once the task
finishes (see server.py). Images/audio stay base64 — only video needs this.

Implemented with raw AWS SigV4 + `requests` (R2 is S3-compatible) so it needs no
extra dependency. Config via R2_* env vars; a no-op / clear error when unset.
"""

from __future__ import annotations

import datetime
import hashlib
import hmac
import os
import uuid
from urllib.parse import quote

import certifi
import requests

_PREFIX = "studio-temp/"


def is_configured() -> bool:
    return all(os.getenv(k) for k in (
        "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_BASE_URL",
    ))


def _host() -> str:
    return f"{os.getenv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com"


def _sign_key(secret: str, date: str, region: str, service: str) -> bytes:
    k = hmac.new(("AWS4" + secret).encode(), date.encode(), hashlib.sha256).digest()
    k = hmac.new(k, region.encode(), hashlib.sha256).digest()
    k = hmac.new(k, service.encode(), hashlib.sha256).digest()
    return hmac.new(k, b"aws4_request", hashlib.sha256).digest()


def _request(method: str, key: str, body: bytes = b"", content_type: str | None = None) -> requests.Response:
    """Signed S3 request to R2 (path-style). `key` is the object key (no leading /)."""
    access = os.getenv("R2_ACCESS_KEY_ID", "")
    secret = os.getenv("R2_SECRET_ACCESS_KEY", "")
    bucket = os.getenv("R2_BUCKET", "")
    host = _host()
    region, service = "auto", "s3"

    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")

    # Canonical URI — path-style /<bucket>/<key>, each segment percent-encoded (keep "/")
    canonical_uri = "/" + quote(f"{bucket}/{key}", safe="/")
    payload_hash = hashlib.sha256(body).hexdigest()

    headers = {
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    if content_type:
        headers["content-type"] = content_type
    signed_headers = ";".join(sorted(headers))
    canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))

    canonical_request = "\n".join([method, canonical_uri, "", canonical_headers, signed_headers, payload_hash])
    scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256", amz_date, scope,
        hashlib.sha256(canonical_request.encode()).hexdigest(),
    ])
    signature = hmac.new(_sign_key(secret, date_stamp, region, service), string_to_sign.encode(), hashlib.sha256).hexdigest()
    headers["Authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    url = f"https://{host}{canonical_uri}"
    return requests.request(method, url, headers=headers, data=body, timeout=120, verify=certifi.where())


def upload_temp(data: bytes, ext: str = "mp4", content_type: str = "video/mp4") -> tuple[str, str]:
    """Upload bytes to studio-temp/<uuid>.<ext>; return (key, public_url)."""
    if not is_configured():
        raise RuntimeError("R2 not configured — set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_BASE_URL in .env")
    key = f"{_PREFIX}{uuid.uuid4().hex}.{ext}"
    resp = _request("PUT", key, data, content_type)
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"R2 upload failed ({resp.status_code}): {resp.text[:300]}")
    base = os.getenv("R2_PUBLIC_BASE_URL", "").rstrip("/")
    return key, f"{base}/{key}"


def delete(keys: list[str]) -> None:
    """Best-effort delete of temp objects (called after a task finishes)."""
    if not is_configured():
        return
    for k in keys:
        try:
            _request("DELETE", k)
        except Exception:
            pass
