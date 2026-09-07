# 02 · Vanilla JS / HTML — the drop-in "Call AI" widget

A floating microphone bubble that connects a visitor to your Silk agent over WebRTC. One `<script>` tag, no bundler, no framework — paste it into Webflow, WordPress, Shopify, a static site, or any page you do not control the build of.

```
┌────────────────┐  POST data-token-url  ┌────────────────┐  POST /v1/webcall  ┌──────────┐
│ any web page   │ ────────────────────▶ │ your backend   │ ─────────────────▶ │ Silk API │
│ + silk-widget  │ ◀──────────────────── │ (shared/…)     │ ◀───────────────── │          │
└───────┬────────┘ {token,host,…}        └────────────────┘                    └──────────┘
        │  livekit-client (CDN) → room.connect(host, token) → mic on → agent audio → hidden <audio>
        └──────────────────────────────────────────────────────────────────────────────────────▶
```

## The copy-paste snippet

```html
<script src="https://your-cdn.example/silk-widget.js"
        data-token-url="https://your-backend.example/api/token"
        data-label="Talk to our AI"
        data-color="#c2410c"
        data-position="bottom-right"></script>
```

| attribute | default | meaning |
| --- | --- | --- |
| `data-token-url` | `/api/token` | your backend route that returns `{ token, host, roomName, callId }` |
| `data-label` | `Talk to our AI` | idle button text |
| `data-color` | `#c2410c` | bubble colour |
| `data-position` | `bottom-right` | or `bottom-left` |
| `data-agent-id` | — | optional; sent as `{ agentId }` if your backend allows choosing |
| `data-livekit-src` | jsDelivr `livekit-client@2` UMD | override to self-host the SDK |

Host `silk-widget.js` anywhere static (your CDN, S3, the theme's assets folder). It loads `livekit-client` lazily on first click, so it costs nothing until someone actually calls.

## Run the demo

```bash
# 1. the token backend (keeps the API key)
cd shared/token-server-node && cp .env.example .env && npm install && npm start   # :8787

# 2. the page
cd 02-vanilla-js-widget && npx serve .        # http://localhost:3000
```

Open the page, click the bubble, allow the microphone. Microphone access needs `https://` or `localhost`.

## What the widget does, step by step

1. **`getUserMedia({ audio: true })` first.** Permission is requested *before* the call is started, because `/v1/webcall` bills from the moment it returns. `NotAllowedError` and `NotFoundError` are turned into readable messages.
2. **`POST data-token-url`.** Errors are surfaced by `code` — `agent_not_deployed`, `insufficient_balance`, `concurrency_limit_exceeded` become friendly text on the bubble.
3. **Load `livekit-client` from the CDN** (skipped if `window.LivekitClient` already exists).
4. **`new Room()` → `room.connect(host, token)` → `setMicrophoneEnabled(true)`.**
5. **Bind audio.** On `RoomEvent.TrackSubscribed`, any audio track is `attach()`ed to a hidden `<audio autoplay playsinline>` element. If the browser blocks autoplay, `RoomEvent.AudioPlaybackStatusChanged` fires, the bubble gets an amber outline, and the next click calls `room.startAudio()`.
6. **Hang up.** The ✕ inside the bubble calls `room.disconnect()`; the call ends and billing stops.

## Barge-in: red → green

The widget keeps three signals and recomputes the state whenever one changes:

```js
// lk.agent.state attribute (listening|thinking|speaking) when the agent publishes it …
room.on(RoomEvent.ParticipantAttributesChanged, (changed, p) => { if (!p.isLocal && changed["lk.agent.state"]) … });
// … plus who is actually making noise right now
room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
  agentSpeaking = speakers.some((p) => !p.isLocal);
  userSpeaking  = speakers.some((p) =>  p.isLocal);
});

var s = agentAttrState || (agentSpeaking ? "speaking" : "listening");
if (s === "speaking" && userSpeaking) s = "interrupting";   // ← barge-in
```

`data-state` on the widget root drives the colour of the pulsing ring: grey listening, amber thinking, **red speaking, green interrupting**. Override any of it from your own stylesheet — the selectors are `.silk-w[data-state=…]`.

## Page-level API

```js
SilkWidget.start();                       // programmatic call (e.g. from your own button)
SilkWidget.stop();
SilkWidget.on("state", (s) => …);         // idle|mic|connecting|listening|thinking|speaking|interrupting|error
SilkWidget.on("connected", ({ callId }) => …);   // callId = the call in the dashboard's conversations
SilkWidget.on("disconnected", () => …);
SilkWidget.on("error", (err) => …);
SilkWidget.state;                         // current state
SilkWidget.room;                          // the underlying livekit Room (or null)
```

## CMS notes

- **WordPress:** paste the tag in *Appearance → Theme File Editor → footer.php* before `</body>`, or use a "header & footer scripts" plugin.
- **Webflow:** *Project settings → Custom code → Footer code*.
- **Shopify:** `theme.liquid`, before `</body>`.
- **Tag managers:** a custom-HTML tag works, but some tag managers strip `data-*` attributes — if that happens, set a `window.SilkWidgetConfig` object before the tag and read it in the script instead.

## Troubleshooting

| symptom | fix |
| --- | --- |
| bubble says "Microphone blocked" | the page is not on https/localhost, or the site is denied in browser settings |
| bubble shows an amber outline, no sound | autoplay blocked; click the bubble once more (`room.startAudio()`) |
| "All lines are busy" | `429 concurrency_limit_exceeded` — check `GET /v1/agent/limits` |
| CORS error in the console | your token backend must allow the page's origin (`CORS_ORIGIN` in the shared server) |
| `could not load livekit-client` | a CSP blocks jsDelivr — self-host the UMD build and set `data-livekit-src` |
