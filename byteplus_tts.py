"""
BytePlus Seed TTS 2.0 — bidirectional WebSocket client (one-shot synthesis).

Implements the documented binary protocol over wss://voice.ap-southeast-1
.bytepluses.com/api/v3/tts/bidirection: StartConnection → StartSession (voice +
audio params) → TaskRequest (text) → FinishSession, collecting the streamed
TTSResponse audio frames into a single audio blob (mp3 by default).

Auth is the simplified X-Api-Key header (recommended in the console upgrade).
This module is self-contained and used only by the Studio's AI Voice mode.
"""

from __future__ import annotations

import json
import os
import ssl
import struct
import uuid
import logging
from typing import Any

import certifi
import websockets

logger = logging.getLogger(__name__)

WS_URL = "wss://voice.ap-southeast-1.bytepluses.com/api/v3/tts/bidirection"


def _ssl_context() -> ssl.SSLContext:
    """Verify TLS with certifi (like `requests`) instead of the system store —
    the macOS Python.framework store is incomplete, which surfaces as a
    'self signed certificate in certificate chain' error for `websockets`.
    Honors a custom CA bundle (corporate proxy) via SSL_CERT_FILE / REQUESTS_CA_BUNDLE."""
    ca = os.getenv("SSL_CERT_FILE") or os.getenv("REQUESTS_CA_BUNDLE") or certifi.where()
    return ssl.create_default_context(cafile=ca)

# Event codes (doc §Event definition)
EV_START_CONNECTION = 1
EV_FINISH_CONNECTION = 2
EV_CONNECTION_STARTED = 50
EV_CONNECTION_FAILED = 51
EV_START_SESSION = 100
EV_FINISH_SESSION = 102
EV_SESSION_STARTED = 150
EV_SESSION_FINISHED = 152
EV_SESSION_FAILED = 153
EV_TASK_REQUEST = 200
EV_TTS_SENTENCE_START = 350
EV_TTS_SENTENCE_END = 351
EV_TTS_RESPONSE = 352

# Message types (byte 1, left nibble)
MT_FULL_CLIENT = 0b0001     # full-client request (JSON)
MT_FULL_SERVER = 0b1001     # full-server response (JSON)
MT_AUDIO_ONLY = 0b1011      # audio-only response
MT_ERROR = 0b1111           # error frame

FLAG_WITH_EVENT = 0b0100    # message-type-specific flag: includes an event number


def _frame(event: int, payload: bytes, *, session_id: str | None = None, serialization_json: bool = True) -> bytes:
    """Build a full-client request frame: 4-byte header + event + [session] + payload."""
    b0 = 0x11                                            # v1, header size = 1 (×4 = 4 bytes)
    b1 = (MT_FULL_CLIENT << 4) | FLAG_WITH_EVENT         # full-client request, with event number
    b2 = (0x01 if serialization_json else 0x00) << 4     # JSON | raw, no compression
    out = bytearray([b0, b1, b2, 0x00])
    out += struct.pack(">i", event)
    if session_id is not None:
        sid = session_id.encode("utf-8")
        out += struct.pack(">I", len(sid)) + sid
    out += struct.pack(">I", len(payload)) + payload
    return bytes(out)


def _parse(data: bytes) -> dict[str, Any]:
    """Parse a server frame → {msg_type, event, payload, error_code}."""
    if len(data) < 4:
        return {"msg_type": None, "event": None, "payload": b"", "error_code": None}
    header_size = (data[0] & 0x0F) * 4
    msg_type = (data[1] >> 4) & 0x0F
    flags = data[1] & 0x0F
    i = header_size
    event = None
    error_code = None
    if msg_type == MT_ERROR:
        # error frame: bytes 4-7 = error code, then payload size + payload
        error_code = struct.unpack(">I", data[i:i + 4])[0]; i += 4
        size = struct.unpack(">I", data[i:i + 4])[0]; i += 4
        return {"msg_type": msg_type, "event": None, "payload": data[i:i + size], "error_code": error_code}
    if flags & FLAG_WITH_EVENT:
        event = struct.unpack(">i", data[i:i + 4])[0]; i += 4
    # connection/session frames carry a length-prefixed id before the payload
    if event in (EV_CONNECTION_STARTED, EV_CONNECTION_FAILED, EV_SESSION_STARTED,
                 EV_SESSION_FINISHED, EV_SESSION_FAILED, EV_TTS_SENTENCE_START,
                 EV_TTS_SENTENCE_END, EV_TTS_RESPONSE):
        if i + 4 <= len(data):
            id_size = struct.unpack(">I", data[i:i + 4])[0]; i += 4
            i += id_size
    payload = b""
    if i + 4 <= len(data):
        size = struct.unpack(">I", data[i:i + 4])[0]; i += 4
        payload = data[i:i + size]
    return {"msg_type": msg_type, "event": event, "payload": payload, "error_code": error_code}


async def synthesize(
    text: str,
    speaker: str,
    *,
    fmt: str = "mp3",
    sample_rate: int = 24000,
    speech_rate: int = 0,
    loudness_rate: int = 0,
    pitch_rate: int = 0,
    emotion: str | None = None,
    additions: dict | None = None,
    api_key: str | None = None,
    resource_id: str | None = None,
) -> bytes:
    """One-shot synthesis → audio bytes. Raises on auth/protocol/synthesis error."""
    api_key = api_key or os.getenv("SEED_TTS_API_KEY", "")
    if not api_key:
        raise RuntimeError("SEED_TTS_API_KEY not set — add it to .env and restart the backend")
    resource_id = resource_id or os.getenv("SEED_TTS_RESOURCE_ID", "seed-tts-2.0")

    audio_params: dict[str, Any] = {"format": fmt, "sample_rate": sample_rate}
    if speech_rate:
        audio_params["speech_rate"] = speech_rate
    if loudness_rate:
        audio_params["loudness_rate"] = loudness_rate
    if pitch_rate:
        audio_params["pitch_rate"] = pitch_rate
    if emotion:
        audio_params["emotion"] = emotion

    add = {"disable_markdown_filter": True, "enable_language_detector": True}
    if additions:
        add.update(additions)

    headers = {
        "X-Api-Key": api_key,
        "X-Api-Resource-Id": resource_id,
        "X-Api-Connect-Id": str(uuid.uuid4()),
    }
    session_id = str(uuid.uuid4())
    start_meta = json.dumps({
        "user": {"uid": "takeone-studio"},
        "namespace": "BidirectionalTTS",
        "req_params": {"speaker": speaker, "audio_params": audio_params, "additions": json.dumps(add, ensure_ascii=False)},
    }, ensure_ascii=False).encode("utf-8")
    task_payload = json.dumps({
        "user": {"uid": "takeone-studio"},
        "req_params": {"text": text, "speaker": speaker, "audio_params": audio_params},
    }, ensure_ascii=False).encode("utf-8")

    audio = bytearray()
    async with websockets.connect(WS_URL, additional_headers=headers, ssl=_ssl_context(), max_size=None, open_timeout=20, close_timeout=10) as ws:
        await ws.send(_frame(EV_START_CONNECTION, b"{}"))
        await ws.send(_frame(EV_START_SESSION, start_meta, session_id=session_id))
        await ws.send(_frame(EV_TASK_REQUEST, task_payload, session_id=session_id))
        await ws.send(_frame(EV_FINISH_SESSION, b"{}", session_id=session_id))

        async for raw in ws:
            if isinstance(raw, str):
                logger.warning("[TTS] text frame: %s", raw[:200])
                continue
            f = _parse(raw)
            if f["msg_type"] == MT_ERROR:
                msg = f["payload"].decode("utf-8", "ignore")
                raise RuntimeError(f"TTS error {f['error_code']}: {msg}")
            ev = f["event"]
            if ev == EV_TTS_RESPONSE and f["msg_type"] == MT_AUDIO_ONLY:
                audio += f["payload"]
            elif ev in (EV_CONNECTION_FAILED, EV_SESSION_FAILED):
                msg = f["payload"].decode("utf-8", "ignore")
                raise RuntimeError(f"TTS failed: {msg}")
            elif ev == EV_SESSION_FINISHED:
                break
        try:
            await ws.send(_frame(EV_FINISH_CONNECTION, b"{}"))
        except Exception:
            pass

    if not audio:
        raise RuntimeError("TTS returned no audio")
    return bytes(audio)
