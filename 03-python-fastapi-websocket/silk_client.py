"""silk_client.py — a small async client for Silk's realtime agent socket.

    wss://silk-api.rumik.ai/v1/agent/connect?token=<wct_…>

Both directions carry base64 PCM: signed 16-bit little-endian, mono, 24 kHz.
Send 20 ms frames (480 samples = 960 bytes); never more than one second per
frame. Do not send audio before `session.created` arrives.

Typical use (server-to-server):

    reg = await register_call(API_KEY, AGENT_ID)          # POST /v1/register-call
    async with SilkRealtimeSession(reg["access_token"]) as s:
        s.on_audio = lambda pcm: play(pcm)                # output_audio.delta
        s.on_event = lambda ev: print(ev["type"])         # everything else
        mic_task = asyncio.create_task(pump_microphone(s))
        closed = await s.run()                            # until session.closed
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
from typing import Any, Awaitable, Callable, Optional

import httpx
import websockets

BASE_URL = os.environ.get("SILK_BASE_URL", "https://silk-api.rumik.ai")

SAMPLE_RATE = 24_000
CHANNELS = 1
SAMPLE_WIDTH = 2                       # bytes per sample (int16)
FRAME_MS = 20
FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS // 1000   # 480
FRAME_BYTES = FRAME_SAMPLES * SAMPLE_WIDTH       # 960
MAX_APPEND_BYTES = SAMPLE_RATE * SAMPLE_WIDTH    # 1 s — the per-frame ceiling


class SilkCallError(RuntimeError):
    """Raised when a call cannot be registered or started."""

    def __init__(self, message: str, code: str | None = None, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status


async def register_call(api_key: str, agent_id: str, base_url: str = BASE_URL) -> dict[str, Any]:
    """Mint a single-use `wct_` token. Free until the socket connects."""
    async with httpx.AsyncClient(timeout=30) as http:
        r = await http.post(
            f"{base_url}/v1/register-call",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"agent_id": agent_id},
        )
    if r.status_code != 201:
        try:
            body = r.json()
        except ValueError:
            body = {}
        raise SilkCallError(
            f"{r.status_code} {body.get('code', 'error')}: {body.get('error', r.text)}",
            code=body.get("code"),
            status=r.status_code,
        )
    return r.json()  # {access_token, expires_in, sample_rate}


def _close_code(exc: BaseException) -> int | None:
    rcvd = getattr(exc, "rcvd", None)
    if rcvd is not None:
        return rcvd.code
    return getattr(exc, "code", None)


AudioHandler = Callable[[bytes], Awaitable[None] | None]
EventHandler = Callable[[dict[str, Any]], Awaitable[None] | None]


class SilkRealtimeSession:
    """One call on the realtime socket."""

    def __init__(self, access_token: str, base_url: str = BASE_URL):
        ws_base = base_url.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
        self.url = f"{ws_base}/v1/agent/connect?token={access_token}"
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.session: dict[str, Any] | None = None   # the session.created payload
        self.on_audio: Optional[AudioHandler] = None  # decoded PCM bytes from output_audio.delta
        self.on_event: Optional[EventHandler] = None  # every other event dict

    # -- lifecycle ---------------------------------------------------------

    async def __aenter__(self) -> "SilkRealtimeSession":
        await self.connect()
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    @classmethod
    async def from_api_key(cls, api_key: str, agent_id: str, base_url: str = BASE_URL) -> "SilkRealtimeSession":
        """Register and connect in one go — the server-to-server shortcut."""
        reg = await register_call(api_key, agent_id, base_url)
        session = cls(reg["access_token"], base_url)
        await session.connect()
        return session

    async def connect(self) -> dict[str, Any]:
        """Open the socket and wait for `session.created` (billing starts here)."""
        try:
            self.ws = await websockets.connect(self.url, max_size=None)
            first = json.loads(await self.ws.recv())
        except websockets.ConnectionClosed as exc:
            code = _close_code(exc)
            if code == 4401:
                raise SilkCallError("token unknown, already spent or expired (4401) — mint a new one", code="4401") from exc
            raise SilkCallError(f"socket closed before session.created (code {code})", code=str(code)) from exc

        if first.get("type") == "error":
            # accepted, one error frame, then a 4000 close — surface the reason
            raise SilkCallError(f"{first.get('code')}: {first.get('message')}", code=first.get("code"))
        if first.get("type") != "session.created":
            raise SilkCallError(f"unexpected first frame: {first}")
        self.session = first
        return first

    async def close(self) -> None:
        """Polite hang-up: send session.close, then close the socket."""
        if self.ws is None:
            return
        try:
            await self.ws.send(json.dumps({"type": "session.close"}))
        except websockets.ConnectionClosed:
            pass
        try:
            await self.ws.close()
        finally:
            self.ws = None

    # -- sending -----------------------------------------------------------

    async def send_audio(self, pcm: bytes) -> None:
        """Append microphone audio (PCM s16le, 24 kHz, mono). Splits >1 s buffers."""
        if self.ws is None:
            return
        for i in range(0, len(pcm), MAX_APPEND_BYTES):
            chunk = pcm[i : i + MAX_APPEND_BYTES]
            await self.ws.send(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(chunk).decode("ascii"),
            }))

    async def send_text(self, text: str) -> None:
        """Type instead of talk."""
        if self.ws is not None:
            await self.ws.send(json.dumps({"type": "input_text.send", "text": text}))

    async def commit(self) -> None:
        """Mark end of turn. Optional — the server's VAD decides turns anyway."""
        if self.ws is not None:
            await self.ws.send(json.dumps({"type": "input_audio_buffer.commit"}))

    # -- receiving ---------------------------------------------------------

    async def run(self) -> dict[str, Any] | None:
        """Receive loop. Returns the `session.closed` event, or None if the socket dropped."""
        if self.ws is None:
            raise RuntimeError("call connect() first")
        try:
            async for raw in self.ws:
                if isinstance(raw, bytes):
                    continue
                event = json.loads(raw)
                kind = event.get("type")
                if kind == "output_audio.delta":
                    if self.on_audio:
                        await _maybe_await(self.on_audio(base64.b64decode(event["audio"])))
                    continue
                if self.on_event:
                    await _maybe_await(self.on_event(event))
                if kind == "session.closed":
                    return event
        except websockets.ConnectionClosed as exc:
            code = _close_code(exc)
            if code not in (None, 1000):
                if self.on_event:
                    await _maybe_await(self.on_event({"type": "error", "code": f"close_{code}", "message": f"socket closed with {code}"}))
        return None


async def _maybe_await(result: Any) -> None:
    if asyncio.iscoroutine(result) or isinstance(result, asyncio.Future):
        await result
