# 03 · Python backend / FastAPI — the realtime socket, server-to-server

No WebRTC, no SDK: a plain WebSocket carrying base64 PCM. This cookbook is for Python engineers who want their **server** to be the client — a bot, a bridge, a pipeline, a test harness — and it also shows how to put a browser in front of that server.

```
                          ┌─────────────────────────────┐   POST /v1/register-call   ┌──────────┐
  (optional) browser ───▶ │  FastAPI  (server.py)       │ ─────────────────────────▶ │ Silk API │
  raw PCM over /ws/agent  │  or a plain script          │ ◀───────────────────────── │          │
                          │  (local_mic.py)             │   { access_token: wct_… }  └────┬─────┘
                          └──────────────┬──────────────┘                                 │
                                         │ wss://silk-api.rumik.ai/v1/agent/connect?token=wct_…
                                         │ ⇅ input_audio_buffer.append / output_audio.delta (PCM s16le 24 kHz)
                                         └────────────────────────────────────────────────────────▶
```

## What you get

| file | role |
| --- | --- |
| `silk_client.py` | `register_call()` + `SilkRealtimeSession` — connect, wait for `session.created`, send audio/text, dispatch events, close codes 4401/4000 |
| `local_mic.py` | talk from your terminal: `pyaudio` in and out, playback queue flushed on `interruption` |
| `server.py` | FastAPI: `/ws/agent` bridge (browser PCM ⇄ Silk) and `/api/agent-token` (mint a token for clients that connect directly) |
| `static/index.html` | the browser side of the bridge: AudioWorklet capture at 24 kHz, gapless playback, red/green orb |

## Run it

```bash
cd 03-python-fastapi-websocket
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # macOS: brew install portaudio first (for pyaudio)
cp .env.example .env                      # RUMIK_API_KEY, RUMIK_AGENT_ID

# A. terminal client — the pure server-to-server path
python local_mic.py

# B. FastAPI bridge + browser page
uvicorn server:app --reload --port 8000   # then open http://localhost:8000
```

## The protocol in 30 seconds

```python
reg = await register_call(API_KEY, AGENT_ID)         # 201 {access_token, expires_in, sample_rate}
async with SilkRealtimeSession(reg["access_token"]) as s:   # waits for session.created
    s.on_audio = play                                 # bytes: PCM s16le 24 kHz mono, 20 ms per delta
    s.on_event = handle                               # transcript / interruption / agent_*_talking / session.closed
    asyncio.create_task(pump_mic(s))                  # s.send_audio(pcm) continuously
    await s.run()                                     # returns on session.closed
```

Audio rules, both directions: **signed 16-bit little-endian, mono, 24 000 Hz, base64 inside JSON.** Send 20 ms frames (480 samples / 960 bytes) and never more than one second per `append`. Do not send anything before `session.created`.

## The token backend

For clients that open the socket themselves (a mobile app, a device) the server only mints tokens:

```python
@app.post("/api/agent-token")
async def agent_token():
    r = await http.post(f"{BASE_URL}/v1/register-call",
                        headers={"Authorization": f"Bearer {API_KEY}"},
                        json={"agent_id": AGENT_ID})
    return JSONResponse(status_code=r.status_code, content=r.json())   # {access_token, expires_in, sample_rate}
```

The token is single-use and expires in `expires_in` seconds; registering costs nothing until the socket connects.

In `server.py` the bridge path skips the client entirely: FastAPI registers **and** connects, so the browser sends raw PCM to `/ws/agent` and never sees a Silk token at all.

## Handling barge-in

The socket tells you explicitly:

```python
elif ev["type"] == "interruption":
    with play_lock:
        play_buf.clear()          # drop every queued output_audio.delta — the agent has abandoned that sentence
```

Without this, the caller talks over the agent and then hears the agent's *old* sentence keep playing for as long as your buffer is deep. In the browser page the same thing is `flushPlayback()`, which stops every scheduled `AudioBufferSourceNode`.

State mapping used by both the terminal and the page:

| event | state | colour |
| --- | --- | --- |
| `session.created` | listening | grey |
| `transcript` (role `user`) | thinking (until the agent starts) | amber |
| `agent_start_talking` | speaking | **red** |
| `interruption` | interrupting | **green** |
| `agent_stop_talking` | listening | grey |

`thinking` is a heuristic on this transport (there is no explicit event for it); the others are driven directly by Silk's frames.

## Connection errors

A call that cannot start is still reported *on the socket*: the connection is accepted, one `error` frame arrives, then close `4000`. `SilkRealtimeSession.connect()` turns that into `SilkCallError` with the `code` (`insufficient_balance`, `concurrency_limit_exceeded`, `agent_start_failed`, `not_configured`). A rejected token is close `4401` — mint a new one, they are cheap.

## Troubleshooting

| symptom | fix |
| --- | --- |
| `pyaudio` fails to install | `brew install portaudio` (macOS) / `apt install portaudio19-dev` (Debian) |
| `[Errno -9997] Invalid sample rate` | your device refuses 24 kHz; open at its native rate and resample (see `11-raspberry-pi/audio_utils.py`) |
| agent talks over itself / echo | terminal client has no echo cancellation — use headphones, or the browser page (which has `echoCancellation: true`) |
| `409 agent_not_deployed` on register | press **Deploy** in the dashboard |
| close `4000` right after connect | read the `error` frame: usually `concurrency_limit_exceeded` or `insufficient_balance` |
