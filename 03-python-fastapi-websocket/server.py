"""server.py — FastAPI bridge: browser ⇄ FastAPI ⇄ Silk realtime socket.

Two ways to use it:

  1. Server-to-server bridge (the point of this cookbook):
       WS /ws/agent   browser sends raw PCM (binary), FastAPI registers a call,
                      connects to Silk, relays audio both ways and forwards the
                      control events (transcripts, interruption, …) as JSON.

  2. Token minting for clients that talk to Silk directly:
       POST /api/agent-token  -> { access_token, expires_in, sample_rate }

Run:  uvicorn server:app --reload --port 8000     then open http://localhost:8000
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from silk_client import BASE_URL, SilkCallError, SilkRealtimeSession, register_call

load_dotenv()
API_KEY = os.environ["RUMIK_API_KEY"]
AGENT_ID = os.environ["RUMIK_AGENT_ID"]

app = FastAPI(title="Silk FastAPI bridge")
STATIC = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


# ---------------------------------------------------------------- token minting
@app.post("/api/agent-token")
async def agent_token() -> JSONResponse:
    """Forward /v1/register-call so a client can open the socket itself."""
    async with httpx.AsyncClient(timeout=30) as http:
        r = await http.post(f"{BASE_URL}/v1/register-call",
                            headers={"Authorization": f"Bearer {API_KEY}"},
                            json={"agent_id": AGENT_ID})
    try:
        body = r.json()
    except ValueError:
        body = {"error": r.text, "code": "upstream_error"}
    return JSONResponse(status_code=r.status_code, content=body)


# ---------------------------------------------------------------- the bridge
@app.websocket("/ws/agent")
async def ws_agent(client: WebSocket) -> None:
    await client.accept()

    # 1. register + connect (server-to-server; the browser never sees a token)
    try:
        reg = await register_call(API_KEY, AGENT_ID)
        session = SilkRealtimeSession(reg["access_token"])
        created = await session.connect()
    except SilkCallError as e:
        await client.send_json({"type": "error", "code": e.code or "start_failed", "message": str(e)})
        await client.close(code=4000)
        return

    await client.send_json(created)                       # session.created → browser
    print(f"[bridge] call {created['call_id']} started")

    async def safe_send_bytes(b: bytes) -> None:
        try:
            await client.send_bytes(b)
        except (WebSocketDisconnect, RuntimeError):
            pass

    async def safe_send_json(o: dict) -> None:
        try:
            await client.send_json(o)
        except (WebSocketDisconnect, RuntimeError):
            pass

    # 2. Silk → browser: audio as binary frames, everything else as JSON text
    session.on_audio = safe_send_bytes
    session.on_event = safe_send_json

    # 3. browser → Silk: binary = PCM 24 kHz mono, text = control frames
    async def pump_up() -> None:
        try:
            while True:
                msg = await client.receive()
                if msg["type"] == "websocket.disconnect":
                    return
                if msg.get("bytes"):
                    await session.send_audio(msg["bytes"])
                elif msg.get("text"):
                    data = json.loads(msg["text"])
                    if data.get("type") == "input_text.send":
                        await session.send_text(data["text"])
                    elif data.get("type") == "session.close":
                        return
        except WebSocketDisconnect:
            return

    down = asyncio.create_task(session.run())
    up = asyncio.create_task(pump_up())
    _done, pending = await asyncio.wait({down, up}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()

    await session.close()
    try:
        await client.close()
    except RuntimeError:
        pass
    print(f"[bridge] call {created['call_id']} ended")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8000")), reload=True)
