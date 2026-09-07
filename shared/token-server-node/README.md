# Shared token server — Node / Express

The credential backend used by the client-only cookbooks (vanilla widget, React Native, Flutter, iOS, Android). It keeps `RUMIK_API_KEY` on the server and exposes three routes:

| route | upstream | returns | used by |
| --- | --- | --- | --- |
| `POST /api/token` | `POST /v1/webcall` | `{ token, host, roomName, callId }` | every WebRTC cookbook |
| `POST /api/agent-token` | `POST /v1/register-call` | `{ access_token, expires_in, sample_rate }` | WebSocket clients that connect to Silk directly |
| `GET /api/limits` | `GET /v1/agent/limits` | `{ concurrency_limit, active_requests, plan }` | queueing / capacity UI |

Upstream status codes and the `{ error, code }` envelope are forwarded unchanged, so clients can branch on `agent_not_deployed`, `insufficient_balance`, `concurrency_limit_exceeded`, etc.

## Run

```bash
cd shared/token-server-node
cp .env.example .env            # fill in RUMIK_API_KEY and RUMIK_AGENT_ID
npm install
npm start                       # http://localhost:8787
```

Smoke test:

```bash
curl -X POST http://localhost:8787/api/token
# {"token":"eyJ…","host":"wss://livekit.rumik.ai","roomName":"call-…","callId":"…"}

curl -X POST http://localhost:8787/api/agent-token
# {"access_token":"wct_…","expires_in":300,"sample_rate":24000}
```

> `POST /api/token` **starts a billed call** the moment it returns, even if nobody joins the room. Only call it when the user has actually pressed "call". `POST /api/agent-token` is free until the socket connects.

## Reaching it from a phone or emulator

- iOS simulator: `http://localhost:8787` works as-is.
- Android emulator: use `http://10.0.2.2:8787`.
- Physical device: use your machine's LAN IP, or tunnel with `ngrok http 8787` and use the `https://` URL.

## Choosing the agent from the client

By default the server ignores whatever agent the client asks for and always uses `RUMIK_AGENT_ID`. If you offer several agents, list them in `ALLOWED_AGENTS` and the client may send `{ "agentId": "ua_…" }`; anything else is refused with `403 forbidden_agent`.
