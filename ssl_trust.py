"""
ssl_trust.py — make Python trust a corporate TLS-inspecting proxy's CA.

WHY this module exists (measured 2026-08-07, cost a render batch):

A TLS-inspecting corporate proxy (e.g. SealSuite SWG) re-signs HTTPS with an
internal CA that lives in the macOS keychain but NOT in Python's certifi bundle.
Every BytePlus call then dies at the handshake with

    SSLCertVerificationError: unable to get local issuer certificate

while curl and the browser work, because those read the system trust store.

`start.sh:22-34` already builds a merged bundle and exports SSL_CERT_FILE — but
that only covers launches that go THROUGH start.sh. A backend started any other
way (`npm run backend`, a bare `uvicorn server:app`, a debugger, an agent
restarting the process) boots perfectly healthy — /api/health returns 200, the
SSE bus runs, the UI looks connected — and then fails EVERY generation at the
handshake. That is a nasty failure mode precisely because nothing looks broken
until a paid render dies. Measured A/B on the same host, same second, one process
each, identical except the variable:

    without SSL_CERT_FILE → ConnectError CERTIFICATE_VERIFY_FAILED
    with    SSL_CERT_FILE → HTTP 200, 62 models

So the trust setup belongs to the APPLICATION, not to one launcher script.
`server.py` calls ensure_ca_bundle() before it imports any module that builds an
SDK client, so every entry point gets the same trust that start.sh gives.

httpx (0.28.1, used by the BytePlus/OpenAI SDKs) and `requests` both honour the
env vars this sets, which is why exporting them is enough and no SDK call site
has to pass a `verify=` argument.
"""

import logging
import os
import ssl
import subprocess
import sys
import time

logger = logging.getLogger(__name__)

# The keychains that hold the machine's trust anchors, in the order start.sh reads
# them: the corporate CA is pushed by MDM into the System keychain, the public
# roots live in SystemRootCertificates.
_KEYCHAINS = (
    "/Library/Keychains/System.keychain",
    "/System/Library/Keychains/SystemRootCertificates.keychain",
)

# Rebuild rather than reuse once the bundle is older than this. start.sh rebuilds on
# every start so a rotated corporate CA is picked up; a host that only ever runs
# `npm run backend` would otherwise keep trusting a stale anchor until it expired
# and then fail exactly the way this module exists to prevent. A rebuild is ~0.5 s
# (two `security` reads) and only happens on a cold import.
_BUNDLE_MAX_AGE_SECS = 24 * 60 * 60

# Same filename and directory start.sh writes, so both paths share ONE bundle
# instead of racing over two. Under a venv sys.prefix IS the venv root (.venv-mac).
_BUNDLE_NAME = "takeone-ca-bundle.pem"


def _bundle_is_fresh(path: str) -> bool:
    """True when `path` is a non-empty bundle young enough to reuse."""
    try:
        return (os.path.isfile(path)
                and os.path.getsize(path) > 0
                and (time.time() - os.path.getmtime(path)) < _BUNDLE_MAX_AGE_SECS)
    except OSError:
        return False


def _build_bundle(path: str) -> bool:
    """
    Write certifi + the macOS trust anchors to `path`. Returns True on success.

    Written to a .tmp and renamed so a crash mid-write can never leave a truncated
    bundle behind — a half-written PEM would break EVERY TLS call, which is worse
    than the problem this module solves.
    """
    import certifi

    parts = [open(certifi.where(), "rb").read()]
    for keychain in _KEYCHAINS:
        # Guarded per keychain: a locked or absent keychain must not lose us the
        # anchors we already read from the other one.
        try:
            r = subprocess.run(["security", "find-certificate", "-a", "-p", keychain],
                               capture_output=True, timeout=30)
            if r.returncode == 0 and r.stdout:
                parts.append(r.stdout)
        except Exception as e:                                    # noqa: BLE001
            logger.debug("[ssl_trust] keychain %s unreadable (non-fatal): %s", keychain, e)

    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(b"\n".join(parts))
    os.replace(tmp, path)
    return True


def _bundle_loads(path: str) -> bool:
    """
    Prove the bundle parses as a trust store BEFORE we point the process at it.

    Exporting a malformed SSL_CERT_FILE breaks every HTTPS call in the process —
    strictly worse than the corporate-CA failure. This is the guard that makes
    installing trust safe to do automatically.
    """
    try:
        ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT).load_verify_locations(cafile=path)
        return True
    except Exception as e:                                        # noqa: BLE001
        logger.warning("[ssl_trust] built bundle does not load (non-fatal): %s", e)
        return False


def ensure_ca_bundle() -> str | None:
    """
    Point Python (and `requests`) at certifi + the macOS trust anchors.

    Returns the bundle path when trust is in place, else None. Best-effort by
    design: this is a connectivity aid, and a keychain read that fails must never
    stop the server from booting — the caller gets the same behaviour it had
    before this module existed (certifi only).

    No-op when:
      - not macOS (no keychain to merge; Linux/CI trust the system store already);
      - SSL_CERT_FILE is already set — start.sh or the operator already chose a
        bundle, and their choice wins over ours.
    """
    if not sys.platform.startswith("darwin"):
        return None

    existing = os.environ.get("SSL_CERT_FILE", "").strip()
    if existing:
        logger.debug("[ssl_trust] SSL_CERT_FILE already set by the launcher — leaving it alone")
        return existing

    try:
        bundle = os.path.join(sys.prefix, _BUNDLE_NAME)
        if not _bundle_is_fresh(bundle):
            _build_bundle(bundle)
        if not _bundle_loads(bundle):
            return None

        os.environ["SSL_CERT_FILE"] = bundle
        os.environ.setdefault("REQUESTS_CA_BUNDLE", bundle)
        logger.info("[ssl_trust] CA bundle = certifi + macOS trust anchors → %s", bundle)
        return bundle
    except Exception as e:                                        # noqa: BLE001
        # Never fatal: without this the process still runs, it just cannot reach a
        # TLS-intercepted host — exactly the state it was in before.
        logger.warning("[ssl_trust] could not install the CA bundle (non-fatal): %s", e)
        return None
