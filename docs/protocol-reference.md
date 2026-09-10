# Protocol reference

A one-page cheat sheet for both transports, distilled from the Silk docs. Base URL: `https://silk-api.rumik.ai`. Authentication for every HTTP call:

```
Authorization: Bearer rk_live_…
```

The key needs the `agent` scope (on by default for dashboard-created keys).

## HTTP endpoints

### `POST /v1/webcall` — start a WebRTC call

Request:

```json
{ "agentId": "ua_xxxxxxxx" }
```

(`agent_id` is accepted too.) Response `200`:

```json
{
  "token": "eyJ…",
  "host": "wss://livekit.rumik.ai",
  "roomName": "call-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "callId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

The call **starts** when this returns. The token is short-lived and scoped to one room — do not reuse it.

### `POST /v1/register-call` — mint a single-use WebSocket token

Request:

```json
{ "agent_id": "ua_xxxxxxxx" }
```

(`agentId` is accepted too.) Response `201`:

```json
{ "access_token": "wct_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "expires_in": 300, "sample_rate": 24000 }
```

Registering does **not** start a call, bill anything or take a concurrency slot. The token is spent the moment the socket connects. It checks the agent is deployed (`409 agent_not_deployed` otherwise) so a caller is never refused after spending a token.

### `GET /v1/agent/limits` — capacity snapshot

```json
{ "concurrency_limit": 4, "active_requests": 1, "plan": "payg" }
```

`active_requests` counts everything on the account (TTS included). Pay-as-you-go accounts get 4 slots. It is a snapshot, not a reservation — still handle `429` on start.

### Error envelope

```json
{ "error": "human-readable message", "code": "machine_readable_code" }
```

| status | `code` | meaning |
| --- | --- | --- |
| 401 | `unauthorized` | key missing, unknown, revoked or expired |
| 403 | `forbidden_scope` | the key lacks the `agent` scope |
| 404 | `agent_not_found` | no such agent on your account |
| 409 | `agent_not_deployed` | agent exists but was never deployed |
| 402 | `insufficient_balance` | balance cannot fund a call |
| 402 | `access_blocked` | account paused after a failed payment |
| 429 | `concurrency_limit_exceeded` | every slot busy — body also has `active_requests` and `limit` |
| 502 | `agent_start_failed` | safe to retry |
| 503 | `not_configured` | voice agents unavailable on this deployment |

## WebSocket: `wss://silk-api.rumik.ai/v1/agent/connect?token=wct_…`

### Audio format (both directions)

| | |
| --- | --- |
| encoding | signed 16-bit PCM, little-endian, **base64 in JSON** |
| channels | 1 |
| sample rate | 24 000 Hz (fixed) |
| recommended frame | 20 ms = 480 samples = 960 bytes (≈ 1280 base64 chars) |
| max per `append` | 1 second of audio (48 000 bytes) |

Handy numbers: 24 kHz × 2 bytes = 48 000 bytes per second; 8 kHz telephony → 24 kHz is exactly ×3; 16 kHz → 24 kHz is ×1.5; 48 kHz → 24 kHz is ÷2.

### Lifecycle

1. connect with the `wct_` token;
2. **wait for `session.created`** — do not send audio before it;
3. stream `input_audio_buffer.append` continuously; play `output_audio.delta` back-to-back;
4. send `session.close` (or just close). You receive `session.closed` with a reason, then a normal close.

### Events you receive

| type | payload | notes |
| --- | --- | --- |
| `session.created` | `session_id`, `call_id`, `sample_rate`, `channels` | always the first frame; billing starts here |
| `output_audio.delta` | `audio` (base64 PCM) | one 20 ms chunk of agent speech; play back-to-back |
| `agent_start_talking` | `timestamp` (ISO-8601) | drive a "speaking" indicator |
| `agent_stop_talking` | `timestamp` | |
| `interruption` | — | the caller spoke over the agent — **flush your playback buffer** |
| `transcript` | `role` (`user`/`assistant`), `text` | a settled turn |
| `transcript.delta` | `role`, `text` | the turn so far |
| `session.closed` | `reason`: `client_requested` · `ended` · `max_duration` · `error` | socket closes right after |
| `error` | `code`, `message` | malformed frame → reported, call continues; fatal → followed by close `4000` |

`transcript`, `transcript.delta`, `agent_start_talking`, `agent_stop_talking` and `interruption` are best-effort enrichment. Never gate the audio pipeline on one arriving.

### Events you send

| type | payload | notes |
| --- | --- | --- |
| `input_audio_buffer.append` | `audio` (base64 PCM) | send continuously; ≤ 1 s per frame |
| `input_audio_buffer.commit` | — | accepted for compatibility; server VAD decides turns |
| `input_text.send` | `text` | type instead of talk |
| `session.close` | — | polite hang-up; you get `session.closed` first |

### Close codes

| code | meaning |
| --- | --- |
| `4401` | token unknown, already spent, or expired — mint a new one |
| `4000` | the call could not start; the preceding `error` frame's `code` says why (`insufficient_balance`, `concurrency_limit_exceeded`, `agent_start_failed`, `not_configured`) |
| `1000` | normal end, after `session.closed` |

A failure before the call starts is still delivered *on the socket*: the connection is accepted, one `error` frame is sent, then the socket closes with `4000`. Handle both the frame and the code.

### Minimal frame builders

```js
// JavaScript — 960-byte Int16 buffer → append frame
const frame = (pcm) => JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") });
```

```python
# Python
import base64, json
def append_frame(pcm: bytes) -> str:
    return json.dumps({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm).decode("ascii")})
```

## LiveKit: what the WebRTC client needs

| item | value |
| --- | --- |
| server URL | `host` from `/v1/webcall` (e.g. `wss://livekit.rumik.ai`) |
| token | `token` from `/v1/webcall` |
| what to publish | the microphone (`setMicrophoneEnabled(true)`) |
| what to play | every subscribed remote **audio** track |
| agent state attribute | `lk.agent.state` on the agent participant, when present: `listening` · `thinking` · `speaking` |
| hang up | `room.disconnect()` — the call ends and billing stops |

Client SDKs used in this repo:

| platform | package |
| --- | --- |
| browser | `livekit-client` (+ `@livekit/components-react` for React) |
| React Native / Expo | `@livekit/react-native`, `@livekit/react-native-webrtc` |
| Flutter | `livekit_client` |
| iOS | `https://github.com/livekit/client-sdk-swift` |
| Android | `io.livekit:livekit-android` |
| Python (edge/servers) | `livekit` |

Versions the cookbooks pin, and were last tested against (2026-09):

| cookbook | package | version |
| --- | --- | --- |
| 01 Next.js | `livekit-client` / `@livekit/components-react` / `@livekit/components-styles` | 2.22.3 / 2.9.24 / 1.2.0 |
| 02 widget | `livekit-client` UMD from jsDelivr | 2.22.3 (exact URL, no floating `@2`) |
| 05 React Native | `@livekit/react-native` / `@livekit/react-native-webrtc` / `livekit-client` | 2.12.0 / 144.1.2 / 2.22.3 |
| 06 Flutter | `livekit_client` | `^2.4.0` (resolves to 2.12.0) |
| 07 iOS | `client-sdk-swift` | 2.x from 2.0.0 (resolves to 2.16.0) |
| 08 Android | `io.livekit:livekit-android` | 2.15.0 |

The JS packages are pinned to exact versions on purpose: the LiveKit React Native SDK and its WebRTC package move in lock-step (`@livekit/react-native` 2.12 requires `@livekit/react-native-webrtc` 144), and caret ranges let them drift apart until a fresh `npm install` fails. Bump them together.

Silk's hosted LiveKit runs server 1.9.12 or newer. Browser and React Native clients from `livekit-client` 2.18.8 onward rely on the server echoing SDP offer ids; an older server makes every call reconnect about every 15 s. If you point a cookbook at a self-hosted LiveKit for local development, use server 1.9.12 or newer.
