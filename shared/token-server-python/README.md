# Shared token server — Python / FastAPI

The Python twin of [`../token-server-node`](../token-server-node). Same three routes, same pass-through behaviour:

| route | upstream | returns |
| --- | --- | --- |
| `POST /api/token` | `POST /v1/webcall` | `{ token, host, roomName, callId }` |
| `POST /api/agent-token` | `POST /v1/register-call` | `{ access_token, expires_in, sample_rate }` |
| `GET /api/limits` | `GET /v1/agent/limits` | `{ concurrency_limit, active_requests, plan }` |

## Run

```bash
cd shared/token-server-python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # fill in RUMIK_API_KEY and RUMIK_AGENT_ID
python main.py                  # http://localhost:8787
```

Smoke test:

```bash
curl -X POST http://localhost:8787/api/agent-token
# {"access_token":"wct_…","expires_in":300,"sample_rate":24000}
```

> `POST /api/token` starts a billed call as soon as it returns. `POST /api/agent-token` costs nothing until the socket connects.

Reaching it from a device: iOS simulator → `localhost`; Android emulator → `10.0.2.2`; physical device → LAN IP or `ngrok http 8787`.
