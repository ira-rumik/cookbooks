# 04 · Node.js backend / Express — the realtime socket, server-to-server

The Node twin of the [FastAPI cookbook](../03-python-fastapi-websocket). No WebRTC, no SDK: a plain WebSocket carrying base64 PCM, driven from a Node process. Use it when your **server** is the client — a bot, a bridge, a pipeline — or as the pattern behind the [telephony bridges](../09-twilio-media-streams).

```
                          ┌─────────────────────────────┐   POST /v1/register-call   ┌──────────┐
  (optional) browser ───▶ │  Express + ws (server.js)   │ ─────────────────────────▶ │ Silk API │
  raw PCM over /ws/agent  │  or a plain script          │ ◀───────────────────────── │          │
                          │  (local-mic.js)             │   { access_token: wct_… }  └────┬─────┘
                          └──────────────┬──────────────┘                                 │
                                         │ wss://silk-api.rumik.ai/v1/agent/connect?token=wct_…
                                         │ ⇅ input_audio_buffer.append / output_audio.delta (PCM s16le 24 kHz)
                                         └────────────────────────────────────────────────────────▶
```

## What you get

| file | role |
| --- | --- |
| `lib/silk-socket.js` | `registerCall()` + `SilkRealtimeSocket` (EventEmitter): connect and resolve on `session.created`, `sendAudio()` with the 1 s split, typed events, close codes 4401/4000 |
| `lib/resampler.js` | streaming FIR + linear resampler for Int16 PCM (used when the mic is not 24 kHz; reused by the telephony cookbooks) |
| `local-mic.js` | talk from your terminal: `node-record-lpcm16` in, `speaker` out, playback queue flushed on `interruption` |
| `server.js` | Express + `ws`: `/ws/agent` bridge (browser PCM ⇄ Silk) and `/api/agent-token` (mint a token for direct clients) |
| `public/index.html` | the browser side: AudioWorklet capture at 24 kHz, gapless playback, red/green orb |

## Run it

```bash
cd 04-nodejs-websocket
cp .env.example .env                 # RUMIK_API_KEY, RUMIK_AGENT_ID
npm install                          # speaker + node-record-lpcm16 are optional deps (need sox / build tools)

# A. terminal client — the pure server-to-server path (brew install sox / apt install sox)
npm run mic

# B. Express bridge + browser page
npm start                            # http://localhost:8000
```

## The protocol in 30 seconds

```js
const reg = await registerCall({ apiKey, agentId });   // 201 { access_token, expires_in, sample_rate }
const call = new SilkRealtimeSocket(reg.access_token);
call.on("audio", (pcm) => play(pcm));                   // Buffer: PCM s16le 24 kHz mono, 20 ms per delta
call.on("interruption", () => flush());                 // barge-in
call.on("transcript", ({ role, text }) => …);
call.on("session.closed", ({ reason }) => …);
await call.connect();                                   // resolves with session.created — billing starts here
call.sendAudio(pcmFrame);                               // every 20 ms
call.close();                                           // polite hang-up
```

Audio rules, both directions: **signed 16-bit little-endian, mono, 24 000 Hz, base64 inside JSON.** Send 20 ms frames (480 samples / 960 bytes) and never more than one second per `append`. Nothing before `session.created` — `connect()` enforces that by not resolving until it arrives.

## The token backend

```js
app.post("/api/agent-token", async (_req, res) => {
  const upstream = await fetch(`${SILK_BASE_URL}/v1/register-call`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUMIK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: RUMIK_AGENT_ID }),
  });
  res.status(upstream.status).json(await upstream.json()); // { access_token, expires_in, sample_rate }
});
```

The bridge path in `server.js` does not even do that: Node registers **and** connects, so the browser sends raw PCM to `/ws/agent` and never holds a Silk token.

## Resampling on the server

`local-mic.js` records at `MIC_RATE` (default 24 000, which sox supports directly). Set `MIC_RATE=16000` to see the resampler in the path:

```js
const resampler = new Resampler(16000, 24000);
rec.stream().on("data", (chunk) => call.sendAudio(int16ToBuffer(resampler.process(bufferToInt16(chunk)))));
```

`Resampler` is stateful: it keeps the FIR history and the fractional read position between chunks, so 20 ms frames join without clicks. The same class is used unchanged for 8 kHz μ-law telephony in cookbooks 09 and 10.

## Handling barge-in

```js
call.on("interruption", () => player.flush());   // drop every queued output_audio.delta
```

`PacedPlayer` in `local-mic.js` deliberately feeds the speaker one 20 ms frame every 20 ms instead of writing everything it receives. That keeps the device buffer shallow, so a flush is *heard* within a frame or two. Write-everything-immediately players cannot un-buffer what they already handed to the OS.

In the browser page the equivalent is `flushPlayback()`, which stops every scheduled `AudioBufferSourceNode`.

State mapping used by both the terminal and the page:

| event | state | colour |
| --- | --- | --- |
| `session.created` | listening | grey |
| `transcript` (role `user`) | thinking (until the agent starts) | amber |
| `agent_start_talking` | speaking | **red** |
| `interruption` | interrupting | **green** |
| `agent_stop_talking` | listening | grey |

## Connection errors

A call that cannot start is still reported *on the socket*: the connection is accepted, one `error` frame arrives, then close `4000`. `connect()` rejects with `SilkCallError` carrying the `code` (`insufficient_balance`, `concurrency_limit_exceeded`, `agent_start_failed`, `not_configured`). A rejected token is close `4401` — mint a new one per call.

Silk's `error` frames are emitted as `silk_error` (not `error`) because an `EventEmitter` throws on an unhandled `error` event.

## Troubleshooting

| symptom | fix |
| --- | --- |
| `speaker` fails to build | needs a C toolchain (`xcode-select --install` / `apt install build-essential libasound2-dev`); it is optional — the bridge does not need it |
| `spawn sox ENOENT` | `brew install sox` / `apt install sox` |
| choppy playback in the terminal | another process is holding the output device, or `MIC_RATE` does not match what sox actually records |
| `409 agent_not_deployed` on register | press **Deploy** in the dashboard |
| close `4000` right after connect | read the `error` frame: usually `concurrency_limit_exceeded` or `insufficient_balance` |
