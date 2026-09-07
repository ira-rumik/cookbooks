# Silk Voice Agent Cookbooks

Copy-paste recipes for putting a [Rumik Silk](https://silk-api.rumik.ai) voice agent into any stack — web, mobile, backend, telephony, and embedded hardware.

Silk exposes two transports for a live call. Every cookbook here uses one of them:

| transport | endpoint | audio handled by | best for |
| --- | --- | --- | --- |
| **WebRTC** (LiveKit) | `POST /v1/webcall` → browser/app joins a LiveKit room | the client SDK (echo cancellation, jitter, codecs negotiated for you) | web apps, mobile apps |
| **WebSocket** (realtime socket) | `POST /v1/register-call` → `wss://silk-api.rumik.ai/v1/agent/connect` | you (raw PCM s16le · 24 kHz · mono) | servers, telephony bridges, embedded devices |

> **Never ship an `rk_live_` API key to a client.** Every cookbook has a tiny backend that swaps the key for a short-lived, single-use credential. Reusable versions live in [`shared/`](./shared).

## The catalog

| # | cookbook | transport | stack |
| --- | --- | --- | --- |
| **Tier 1 — must-haves** | | | |
| 01 | [React / Next.js](./01-nextjs-webrtc) | WebRTC | Next.js App Router, `@livekit/components-react`, `useVoiceAssistant()` |
| 02 | [Vanilla JS drop-in widget](./02-vanilla-js-widget) | WebRTC | one `<script>` tag, `livekit-client` from a CDN, floating "Call AI" bubble |
| 03 | [Python backend / FastAPI](./03-python-fastapi-websocket) | WebSocket | FastAPI, `websockets`, `pyaudio` (server-to-server, plus a browser bridge) |
| 04 | [Node.js backend / Express](./04-nodejs-websocket) | WebSocket | Express, `ws`, `node-record-lpcm16` + `speaker` (server-to-server, plus a browser bridge) |
| **Tier 2 — mobile** | | | |
| 05 | [React Native / Expo](./05-react-native-expo) | WebRTC | Expo dev build, `@livekit/react-native`, `AudioSession` echo-safe setup |
| 06 | [Flutter](./06-flutter) | WebRTC | Dart, `livekit_client`, `ChangeNotifier` state |
| 07 | [iOS native (Swift)](./07-ios-swift) | WebRTC | SwiftUI, `livekit-client-swift`, `AVAudioSession` routing |
| 08 | [Android native (Kotlin)](./08-android-kotlin) | WebRTC | Jetpack Compose, `livekit-android`, `AudioSwitch` routing |
| **Tier 3 — telephony** | | | |
| 09 | [Twilio Media Streams](./09-twilio-media-streams) | WebSocket | Node/Express, TwiML `<Connect><Stream>`, μ-law 8 kHz ⇄ PCM 24 kHz bridge |
| 10 | [Generic Node.js telephony bridge](./10-nodejs-telephony-bridge) | WebSocket | `ws`, dynamic resampling, adapters for Plivo, Exotel and raw PCM/SIP |

Supporting material:

- [`docs/architecture.md`](./docs/architecture.md) — the 3-step diagram every cookbook follows, for both transports.
- [`docs/protocol-reference.md`](./docs/protocol-reference.md) — every WebSocket event, the frame math, close codes, and the HTTP error envelope.
- [`docs/audio-resampling.md`](./docs/audio-resampling.md) — μ-law, A-law and sample-rate conversion, with reference code.
- [`shared/token-server-node`](./shared/token-server-node) and [`shared/token-server-python`](./shared/token-server-python) — the credential backends the client-only cookbooks point at.

## Before you run anything

1. **Create and deploy an agent** in the [dashboard](https://playground.rumik.ai). Saving makes a draft; pressing **deploy** is what makes it answer. An undeployed agent returns `409 agent_not_deployed`.
2. **Create an API key** (the `agent` scope is on by default). It is shown once.
3. Export both:

```bash
export RUMIK_API_KEY=rk_live_xxxxxxxxxxxxxxxx
export RUMIK_AGENT_ID=ua_xxxxxxxx        # UUID or ua_ handle, either works
```

Every cookbook reads these two variables (and an optional `SILK_BASE_URL`, default `https://silk-api.rumik.ai`).

4. Optional: check capacity before you start a call.

```bash
curl https://silk-api.rumik.ai/v1/agent/limits -H "Authorization: Bearer $RUMIK_API_KEY"
# {"concurrency_limit":4,"active_requests":0,"plan":"payg"}
```

## The anatomy of every cookbook

Each folder is self-contained and follows the same shape, so once you have read one you can skim the rest:

1. **Architecture diagram** — client → your backend → Silk → client connects.
2. **The token backend** — the server snippet that calls `/v1/webcall` or `/v1/register-call` with your key and forwards only the result.
3. **Copy-paste boilerplate** — the minimal client code needed to hear the agent speak.
4. **Barge-in / interruptions** — how the UI reflects the caller talking over the agent. On the WebSocket you get an explicit `interruption` event; over WebRTC you watch who is speaking. Every visualizer in this repo goes **red while the agent talks** and **green the moment the caller cuts in**.
5. **Run instructions** and a troubleshooting table.

## Which transport should I use?

- The audio lives in a **browser or a mobile app** → WebRTC. The SDK handles echo cancellation, packet loss and codec negotiation; the media never touches your servers.
- The audio lives in **a buffer you already own** — a phone carrier stream, a server-side pipeline, a microphone on a device with no browser → WebSocket. You must deliver PCM s16le at 24 kHz mono and play back the same.

Both transports cost the same; billing depends on your plan, not on how the caller connected.

## License

MIT — see [LICENSE](./LICENSE).
