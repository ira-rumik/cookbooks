"""Silk token server (Python / FastAPI).

Three endpoints, all of which keep RUMIK_API_KEY on the server:

    POST /api/token        -> POST /v1/webcall        (WebRTC join credentials)
    POST /api/agent-token  -> POST /v1/register-call  (single-use WebSocket token)
    GET  /api/limits       -> GET  /v1/agent/limits   (capacity snapshot)

Every upstream response is forwarded verbatim, including its status code, so
the client sees the real Silk error envelope ({"error": ..., "code": ...}).
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

load_dotenv()

RUMIK_API_KEY = os.environ.get("RUMIK_API_KEY")
RUMIK_AGENT_ID = os.environ.get("RUMIK_AGENT_ID")
SILK_BASE_URL = os.environ.get("SILK_BASE_URL", "https://silk-api.rumik.ai")
CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "*")

if not RUMIK_API_KEY or not RUMIK_AGENT_ID:
    raise SystemExit("Set RUMIK_API_KEY and RUMIK_AGENT_ID (see ../../.env.example)")

ALLOWED_AGENTS = {
    a.strip() for a in os.environ.get("ALLOWED_AGENTS", RUMIK_AGENT_ID).split(",") if a.strip()
}

app = FastAPI(title="Silk token server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[CORS_ORIGIN] if CORS_ORIGIN != "*" else ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_http = httpx.AsyncClient(
    base_url=SILK_BASE_URL,
    headers={"Authorization": f"Bearer {RUMIK_API_KEY}"},
    timeout=30,
)


async def silk(method: str, path: str, json: dict[str, Any] | None = None) -> JSONResponse:
    """Call Silk with the server-side key and forward status + body unchanged."""
    r = await _http.request(method, path, json=json)
    try:
        body = r.json()
    except ValueError:
        body = {"error": "upstream returned a non-JSON body", "code": "upstream_error"}
    return JSONResponse(status_code=r.status_code, content=body)


async def resolve_agent(request: Request) -> str | None:
    try:
        body = await request.json()
    except Exception:
        body = {}
    requested = body.get("agentId") or body.get("agent_id") if isinstance(body, dict) else None
    if not requested:
        return RUMIK_AGENT_ID
    return requested if requested in ALLOWED_AGENTS else None


@app.post("/api/token")
async def webrtc_token(request: Request) -> JSONResponse:
    """WebRTC: start the call now and hand the client the LiveKit join credentials."""
    agent = await resolve_agent(request)
    if agent is None:
        return JSONResponse(status_code=403, content={"error": "agent not allowed", "code": "forbidden_agent"})
    return await silk("POST", "/v1/webcall", {"agentId": agent})  # {token, host, roomName, callId}


@app.post("/api/agent-token")
async def websocket_token(request: Request) -> JSONResponse:
    """WebSocket: mint a single-use wct_ token. Nothing is billed until the socket connects."""
    agent = await resolve_agent(request)
    if agent is None:
        return JSONResponse(status_code=403, content={"error": "agent not allowed", "code": "forbidden_agent"})
    return await silk("POST", "/v1/register-call", {"agent_id": agent})  # {access_token, expires_in, sample_rate}


@app.get("/api/limits")
async def limits() -> JSONResponse:
    """Capacity snapshot — queue callers instead of discovering a 429 mid-flow."""
    return await silk("GET", "/v1/agent/limits")  # {concurrency_limit, active_requests, plan}


@app.get("/healthz")
async def healthz() -> dict[str, bool]:
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8787")), reload=True)
