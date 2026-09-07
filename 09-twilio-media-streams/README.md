# 09 · Twilio Media Streams — a Silk agent on a real phone number

Give your agent a PSTN number. Twilio answers the call, opens a bidirectional Media Stream to your Node server, and the server acts as a real-time translator between Twilio's μ-law 8 kHz and Silk's PCM 24 kHz socket.

```
  caller ──PSTN──▶ Twilio ──POST /voice──▶ Node/Express ──TwiML <Connect><Stream>──▶ Twilio
                                                                                         │
     ┌───────────────────────────────────────────────────────────────────────────────────┘
     ▼  wss://your-host/media   (JSON frames, μ-law 8 kHz base64, 20 ms)
  ┌──────────────────────────────┐   POST /v1/register-call            ┌──────────┐
  │  TwilioBridge (server.js)    │ ───────────────────────────────────▶ │ Silk API │
  │  μ-law→PCM, 8k→24k, 24k→8k,  │   wss://…/v1/agent/connect?token=…  │          │
  │  PCM→μ-law, clear on         │ ◀══════════════════════════════════▶ │  agent   │
  │  interruption                │   PCM 24 kHz base64, 20 ms          └──────────┘
  └──────────────────────────────┘
```

Silk's transport here is the [realtime socket](../docs/protocol-reference.md#websocket-wsssilk-apirumikaiv1agentconnecttokenwct_); LiveKit is not involved.

## What you get

| file | role |
| --- | --- |
| `server.js` | `POST /voice` webhook (TwiML) + `WS /media` bridge (`TwilioBridge`) |
| `lib/mulaw.js` | table-driven G.711 μ-law ⇄ 16-bit PCM |
| `lib/resampler.js` | streaming 8 kHz ⇄ 24 kHz (FIR low-pass on the way down) |
| `lib/silk-socket.js` | the Silk realtime socket client (same as cookbook 04) |

## Run it

```bash
cd 09-twilio-media-streams
cp .env.example .env            # RUMIK_API_KEY, RUMIK_AGENT_ID
npm install
npm start                       # :3000

# expose it (new terminal)
ngrok http 3000                 # → https://abcd1234.ngrok-free.app
```

Put the ngrok host in `.env` as `PUBLIC_HOST=abcd1234.ngrok-free.app` (restart), then in the Twilio console open your phone number → **Voice & Fax → A call comes in** → Webhook `https://abcd1234.ngrok-free.app/voice`, method `POST`. Call the number.

## Step 1 — answer the call with `<Connect><Stream>`

```js
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const stream = twiml.connect().stream({ url: `wss://${PUBLIC_HOST}/media` });
  stream.parameter({ name: "from", value: req.body.From });   // arrives in the stream's `start` event
  res.type("text/xml").send(twiml.toString());
});
```

```xml
<Response>
  <Connect>
    <Stream url="wss://abcd1234.ngrok-free.app/media">
      <Parameter name="from" value="+15551234567"/>
    </Stream>
  </Connect>
</Response>
```

`<Connect><Stream>` is **bidirectional**: Twilio sends the caller's audio and plays whatever you send back. (`<Start><Stream>` is listen-only — do not use it here.) When the stream ends, Twilio continues with the TwiML after `<Connect>`; there is none, so the call ends.

## Step 2 — the token backend is the bridge itself

The bridge runs on your server, so it calls Silk with the API key directly, one token per phone call, when Twilio's `start` event arrives:

```js
const reg  = await registerCall({ apiKey: RUMIK_API_KEY, agentId: RUMIK_AGENT_ID });   // POST /v1/register-call
const silk = new SilkRealtimeSocket(reg.access_token);
await silk.connect();                                                                 // session.created
```

Twilio starts sending `media` frames before Silk is ready; those first few are dropped because Silk must not receive audio before `session.created`. The counter is logged.

## Step 3 — the translator

Twilio's format: μ-law, 8 000 Hz, mono, base64, one `media` event every 20 ms = 160 bytes. Silk's format: PCM s16le, 24 000 Hz, mono, base64, recommended 20 ms = 960 bytes. Same frame duration, ×3 the sample rate — one Twilio frame becomes exactly one Silk frame:

```js
// caller → agent
const pcm8k  = mulawToPcm(Buffer.from(msg.media.payload, "base64"));   // Int16Array(160)
const pcm24k = up.process(pcm8k);                                      // Int16Array(480)
silk.sendAudio(int16ToBuffer(pcm24k));                                 // 960 bytes → input_audio_buffer.append

// agent → caller
const pcm8k   = down.process(bufferToInt16(pcm));                      // low-pass at 3.6 kHz, then ÷3
const payload = pcmToMulaw(pcm8k).toString("base64");
send({ event: "media", streamSid, media: { payload } });
```

Both `Resampler` instances are stateful (filter history + fractional position) so frames join without clicks. See [`docs/audio-resampling.md`](../docs/audio-resampling.md) for why the low-pass matters on the way down.

## Barge-in: `interruption` → `clear`

Twilio buffers the audio you send and plays it out at its own pace. When the caller talks over the agent, Silk stops generating and sends `interruption` — but Twilio may still hold a second or more of the agent's old sentence. Twilio's `clear` message drops it:

```js
silk.on("interruption", () => send({ event: "clear", streamSid }));
```

Without this the caller hears the agent "finish" a sentence it has already abandoned, then answer. With it, the agent goes quiet within a frame or two. The server log shows the sequence:

```
[CA…] agent speaking
[CA…] caller interrupted → sent clear
[CA…] user: actually I meant tomorrow
[CA…] agent speaking
```

## Twilio stream events, for reference

| event | direction | notes |
| --- | --- | --- |
| `connected` | Twilio → you | socket is up |
| `start` | Twilio → you | `streamSid`, `callSid`, `mediaFormat`, `customParameters` |
| `media` | both | `media.payload` base64 μ-law; outbound needs `streamSid` |
| `clear` | you → Twilio | flush Twilio's outbound buffer (barge-in) |
| `mark` | both | optional playback checkpoints |
| `stop` | Twilio → you | caller hung up or TwiML ended |

## Production notes

- **Validate webhooks.** Set `TWILIO_AUTH_TOKEN` and `twilio.webhook()` rejects unsigned requests to `/voice`.
- **Concurrency.** Each phone call holds one Silk slot for its whole duration. Check `GET /v1/agent/limits` and, if you are out of slots, answer with `<Say>` + `<Hangup>` instead of `<Connect>`.
- **Use `callSid` ↔ `call_id`.** Log both (the bridge does) so a Twilio call can be found under **conversations** in the Silk dashboard.
- **Latency.** ngrok adds ~50 ms; deploy near Twilio's region (`us1` by default) for the tightest turn-taking.

## Troubleshooting

| symptom | fix |
| --- | --- |
| call connects then silence | `PUBLIC_HOST` wrong, or the ws upgrade is blocked — check the `/media` connection in the server log |
| caller hears clicks | you replaced `Resampler` with a stateless one; frames must share filter state |
| agent sounds muffled | expected: 8 kHz telephony has no content above 4 kHz |
| `31920 Stream - WebSocket - Handshake Error` in Twilio debugger | your server is not reachable over `wss://` — ngrok must be `https`, and `/media` must be the upgrade path |
| close `4000` right after Silk connect | `concurrency_limit_exceeded` or `insufficient_balance` — read the `silk error` line |
