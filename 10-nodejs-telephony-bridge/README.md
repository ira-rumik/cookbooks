# 10 · Node.js telephony bridge — Plivo, Exotel, SIP and anything else

A provider-agnostic bridge between carrier audio streams and Silk's realtime socket. Where the [Twilio cookbook](../09-twilio-media-streams) is a single hard-wired path, this one separates **the carrier adapter** (how a provider frames its stream) from **the bridge core** (codec conversion, dynamic resampling, the Silk socket, barge-in), so adding a provider is one small file.

```
  Plivo ───── wss /plivo  ──┐
  Exotel ──── wss /exotel ──┤     ┌──────────────────────────┐   register-call + wss   ┌──────────┐
  SIP/PBX ─── ws  /pcm ─────┼───▶ │  adapters/*.js           │ ◀═════════════════════▶ │ Silk API │
  local-mic ─ ws  /pcm ─────┘     │  → lib/call-bridge.js    │   PCM 24 kHz, 20 ms      │  agent   │
                                  │    decode → resample ↑   │                          └──────────┘
                                  │    resample ↓ → encode   │
                                  │    interruption → clear  │
                                  └──────────────────────────┘
```

## What you get

| file | role |
| --- | --- |
| `bridge.js` | Express + `ws` server; routes `/plivo`, `/exotel`, `/pcm` to adapters; serves Plivo's answer XML |
| `lib/call-bridge.js` | **the core**: `configure({ inRate, inCodec, … })` builds converters per call; `start()` registers + connects; `pushCallerAudio()`; `interruption` → `onClear()` |
| `lib/codecs.js` | μ-law, A-law and L16 ⇄ Int16, table driven; `normaliseCodec()` for the carriers' many spellings |
| `lib/resampler.js` | stateful FIR + linear resampler, any ratio |
| `lib/silk-socket.js` | the Silk realtime socket client (same as cookbook 04) |
| `adapters/plivo.js` | Plivo Audio Streams: `start/media/dtmf/stop` in, `playAudio`/`clearAudio` out |
| `adapters/exotel.js` | Exotel Voicebot: L16 8 kHz both ways, 200 ms outbound batching, `clear` |
| `adapters/generic-pcm.js` | raw binary frames, `?rate=&codec=` in the URL; JSON control frames out |
| `local-mic.js` | test the whole path from your laptop microphone via `/pcm` |

## Run it

```bash
cd 10-nodejs-telephony-bridge
cp .env.example .env            # RUMIK_API_KEY, RUMIK_AGENT_ID, PUBLIC_HOST (ngrok host)
npm install
npm start                       # :3000
ngrok http 3000                 # for a real carrier
```

Test without a carrier (needs `sox` for the microphone):

```bash
npm run mic                     # laptop mic → /pcm → Silk → speaker; talk over the agent to see "interrupted"
```

### Plivo

1. `.env`: `PLIVO_CONTENT_TYPE=audio/x-l16;rate=16000` (best quality Plivo offers) or `audio/x-mulaw;rate=8000`.
2. Plivo console → your number → **Answer URL** `https://<PUBLIC_HOST>/plivo/answer`, method `POST`. The bridge replies:

```xml
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-l16;rate=16000">wss://<PUBLIC_HOST>/plivo</Stream>
</Response>
```

3. Call the number. The adapter reads Plivo's `start.mediaFormat` and configures the resampler from **that**, not from your config — if Plivo ever sends a different rate than you asked for, the bridge still sounds right.

### Exotel

1. In the Exotel App Bazaar, add a **Voicebot** applet to your flow and set its URL to `wss://<PUBLIC_HOST>/exotel`.
2. Exotel streams raw 16-bit PCM at 8 kHz, base64, both ways. It requires outbound chunks of ≥ 3.2 kB in multiples of 320 bytes, so the adapter sets `outChunkBytes` to 200 ms and the core batches before sending.

### SIP trunks / PBX / your own client

Point anything that can produce raw audio at:

```
ws://<host>/pcm?rate=8000&codec=mulaw      # binary frames in and out, JSON text frames for control
```

Examples: FreeSWITCH `mod_audio_fork` (L16 8/16 kHz), an Asterisk AudioSocket forwarder, a Kamailio/RTPengine tap, a softphone. Frame size is free-form; the resampler keeps state across calls.

## Dynamic resampling on the server

The converters are built per call, from the carrier's declared format:

```js
bridge.configure({ inRate: fmt.sampleRate, inCodec: normaliseCodec(fmt.encoding), outRate, outCodec });
// → up   = new Resampler(inRate, 24000)      caller → Silk
// → down = new Resampler(24000, outRate)     Silk → caller (low-pass first when outRate < 24000)
```

`Resampler` handles any ratio (8 → 24 is ×3, 16 → 24 is ×1.5, 44.1 → 24 is ÷1.8375) and keeps the FIR history plus the fractional read position between frames, so 20 ms carrier frames join without clicks. Details and the theory are in [`docs/audio-resampling.md`](../docs/audio-resampling.md).

`node-record-lpcm16` is a **capture** library (it wraps `sox`/`rec`/`arecord`), not a resampler — `local-mic.js` uses it to get PCM off your laptop's microphone at `MIC_RATE`, and the bridge does the rate conversion exactly as it would for a carrier.

## Barge-in: `interruption` → carrier `clear`

Carriers buffer outbound audio and play it at their own pace, so when the caller talks over the agent there is stale audio in two places: what the bridge has not sent yet, and what the carrier has not played yet. `CallBridge` clears both:

```js
silk.on("interruption", () => {
  this.outBatch = [];      // ours
  this.onClear();          // theirs: Plivo clearAudio · Exotel clear · generic {"type":"clear"}
});
```

## Adding a provider

Write `adapters/<name>.js` with one exported function `attach(ws, req)` that:

1. on the provider's *start* event, creates a `CallBridge` with `onAudioOut` / `onClear` that speak the provider's outbound format, calls `configure()` with the inbound format, then `await bridge.start()`;
2. on *media*, calls `bridge.pushCallerAudio(Buffer)`;
3. on *stop* / socket close, calls `bridge.end()`.

Register it in `ROUTES` in `bridge.js`. Plivo's adapter is 60 lines.

## Troubleshooting

| symptom | fix |
| --- | --- |
| caller hears garbage / chipmunks | wrong `inRate`/`inCodec` — log the carrier's `start` event and compare |
| Exotel plays nothing | outbound chunks too small; keep `outChunkBytes ≥ 3200` and a multiple of 320 |
| Plivo: silence after connect | `PLIVO_CONTENT_TYPE` must match what the XML advertised, and `bidirectional="true"` |
| clicks every 20 ms | a stateless resampler was substituted; keep one `Resampler` per direction per call |
| `dropped N early frames` is large | the carrier streamed for a while before Silk's `session.created`; expected and harmless |
| close `4000` after Silk connect | `concurrency_limit_exceeded` / `insufficient_balance` — check `GET /v1/agent/limits` |
