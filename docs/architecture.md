# Architecture

Every cookbook in this repository is the same three-step story. Only the client and the transport change.

```
 ┌──────────────┐   1. "start a call"    ┌──────────────────┐   2. API key + agent id   ┌─────────────────┐
 │    client    │ ─────────────────────▶ │   your backend   │ ────────────────────────▶ │   Silk API      │
 │ (web/mobile/ │                        │ (Node / Python / │                           │ silk-api.rumik  │
 │  phone/edge) │ ◀───────────────────── │  anything)       │ ◀──────────────────────── │      .ai        │
 └──────┬───────┘   short-lived cred     └──────────────────┘   { token | access_token } └────────┬────────┘
        │                                                                                         │
        │ 3. client connects with the credential — media flows directly, never through your backend
        └─────────────────────────────────────────────────────────────────────────────────────────┘
```

The API key never leaves your backend. The client receives something that is short-lived, scoped to one call, and worthless after it is used.

## Transport A — WebRTC (LiveKit)

Used by the web, React Native, Flutter, iOS and Android cookbooks.

```mermaid
sequenceDiagram
    participant C as Client (browser / app)
    participant B as Your backend
    participant S as Silk API
    participant L as LiveKit (wss://livekit.rumik.ai)
    participant A as Agent

    C->>B: POST /api/token
    B->>S: POST /v1/webcall { agentId } (Authorization: Bearer rk_live_…)
    S-->>B: { token, host, roomName, callId }
    B-->>C: { token, host, roomName, callId }
    C->>L: room.connect(host, token)
    C->>L: publish microphone
    A->>L: joins the room, greets the caller
    L-->>C: agent audio track (TrackSubscribed)
    Note over C,A: audio flows C ⇄ L ⇄ A — echo cancellation, jitter and codecs are the SDK's job
    C->>L: room.disconnect()  →  call ends, billing stops
```

What the client is responsible for:

- attaching the agent's audio track to an output (an `<audio>` element on the web, the platform audio session on mobile);
- enabling the microphone;
- turning "who is speaking" into UI state (see barge-in below).

What the client is **not** responsible for: sample rates, codecs, echo, packet loss.

### Agent state over WebRTC

If the agent participant publishes the LiveKit `lk.agent.state` attribute (`listening` / `thinking` / `speaking`), the `useVoiceAssistant()` hook and its equivalents read it directly. Every cookbook also falls back to active-speaker detection so that state still works if the attribute is absent:

| signal | UI state |
| --- | --- |
| agent is an active speaker | `speaking` (red) |
| local participant is an active speaker while the agent is `speaking` | `interrupting` (green) — barge-in |
| neither | `listening` (grey) |
| `lk.agent.state == thinking` | `thinking` (amber) |

## Transport B — WebSocket (realtime socket)

Used by the Python, Node.js and telephony cookbooks.

```mermaid
sequenceDiagram
    participant C as Client (server / device / phone bridge)
    participant B as Your backend
    participant S as Silk API

    C->>B: POST /api/agent-token
    B->>S: POST /v1/register-call { agent_id } (Authorization: Bearer rk_live_…)
    S-->>B: 201 { access_token: "wct_…", expires_in, sample_rate: 24000 }
    B-->>C: { access_token, … }
    C->>S: WebSocket wss://…/v1/agent/connect?token=wct_…
    S-->>C: { type: "session.created", call_id, sample_rate, channels }
    Note over C,S: billing and the concurrency slot start HERE, not at register
    loop every 20 ms
        C->>S: { type: "input_audio_buffer.append", audio: base64 PCM }
        S-->>C: { type: "output_audio.delta", audio: base64 PCM }
    end
    S-->>C: agent_start_talking / agent_stop_talking / transcript / interruption
    C->>S: { type: "session.close" }
    S-->>C: { type: "session.closed", reason }
```

When your backend *is* the client (server-to-server), collapse steps 1–3: register and connect from the same process.

What the client is responsible for:

- delivering **PCM signed 16-bit little-endian, mono, 24 000 Hz**, ideally in 20 ms frames (480 samples = 960 bytes);
- resampling anything that is not 24 kHz (telephony is 8 kHz μ-law, most USB mics are 44.1/48 kHz);
- playing `output_audio.delta` frames back-to-back, and **flushing the playback buffer on `interruption`** — otherwise the caller hears the agent finish a sentence it has already abandoned;
- not sending audio before `session.created`.

## Barge-in, side by side

| | WebRTC | WebSocket |
| --- | --- | --- |
| who stops the agent's speech | the agent, server-side | the agent, server-side |
| how the client finds out | local participant becomes an active speaker while the agent is speaking; `lk.agent.state` flips back to `listening` | explicit `{ "type": "interruption" }` event, followed by `agent_stop_talking` |
| what the client must do | nothing for audio; update the UI | **drop any buffered `output_audio.delta` not yet played**, then update the UI |
| what the demos show | visualizer turns from red to green | visualizer turns from red to green, playback queue length drops to zero |

## Where the call shows up

Both transports return a call id (`callId` on `/v1/webcall`, `call_id` in `session.created`). It is the key into **conversations** in the dashboard, where the transcript and recording appear shortly after the call ends. Store it next to your own user/session record if you want to correlate later.
