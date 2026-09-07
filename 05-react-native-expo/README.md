# 05 · React Native / Expo — voice agent over WebRTC

Ship the Silk agent to iOS and Android from one codebase with `@livekit/react-native`. LiveKit handles echo cancellation, cellular jitter and codec negotiation natively; the two things you must get right are `registerGlobals()` and the audio session.

```
┌───────────────┐  POST /api/token   ┌────────────────┐  POST /v1/webcall  ┌──────────┐
│ Expo app      │ ─────────────────▶ │ your backend   │ ─────────────────▶ │ Silk API │
│ (iOS/Android) │ ◀───────────────── │ (shared/…)     │ ◀───────────────── │          │
└──────┬────────┘ {token,host,…}     └────────────────┘                    └──────────┘
       │  AudioSession.startAudioSession() → room.connect(host, token) → mic on → agent audio
       └───────────────── native WebRTC ─────────────▶ wss://livekit.rumik.ai ◀── agent joins
```

> **Expo Go cannot run this.** WebRTC is native code, so you need a development build (`expo-dev-client`). It is a one-time `prebuild`, after which the workflow is the usual `expo start`.

## What you get

| file | role |
| --- | --- |
| `App.tsx` | `registerGlobals()` — must run before any Room exists |
| `src/audio.ts` | **the echo fix**: `AudioSession.configureAudio` + `setAppleAudioConfiguration` + `startAudioSession()` |
| `src/api.ts` | `POST EXPO_PUBLIC_TOKEN_URL` → `{ token, host, roomName, callId }` with friendly error mapping |
| `src/useAgentState.ts` | `useVoiceAssistant()` + active-speaker fallback + `interrupting` |
| `src/VoiceAgentScreen.tsx` | permission → audio session → credentials → `<LiveKitRoom>` → `<BarVisualizer>` |
| `app.json` | the config plugins that add native WebRTC + the mic permission strings |

## Run it

```bash
# 0. token backend (keeps the API key)
cd shared/token-server-node && cp .env.example .env && npm install && npm start     # :8787

# 1. the app
cd 05-react-native-expo
npm install
cp .env.example .env               # EXPO_PUBLIC_TOKEN_URL — see "reaching the backend" below
npx expo prebuild                  # generates ios/ and android/ with the WebRTC plugins applied
npx expo run:ios --device          # or: npx expo run:android
```

Simulators have no microphone worth testing with; use a physical device.

### Reaching the backend from the phone

| target | `EXPO_PUBLIC_TOKEN_URL` |
| --- | --- |
| iOS simulator | `http://localhost:8787/api/token` |
| Android emulator | `http://10.0.2.2:8787/api/token` |
| physical device | `http://<your-LAN-IP>:8787/api/token`, or `ngrok http 8787` → `https://…/api/token` |

`usesCleartextTraffic: true` in `app.json` allows plain `http://` on Android during development; drop it for release.

## The token backend

Any of the shared servers works unchanged — the app only needs `POST /api/token` to return what `/v1/webcall` returned:

```js
app.post("/api/token", async (req, res) => {
  const upstream = await fetch("https://silk-api.rumik.ai/v1/webcall", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RUMIK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: process.env.RUMIK_AGENT_ID }),
  });
  res.status(upstream.status).json(await upstream.json());   // { token, host, roomName, callId }
});
```

## Step 1 — `registerGlobals()`

```ts
import { registerGlobals } from "@livekit/react-native";
registerGlobals();   // first lines of App.tsx, before anything imports a Room
```

It installs `RTCPeerConnection`, `MediaStream` and friends from `@livekit/react-native-webrtc` onto `global`, which is where `livekit-client` looks for them. Forget it and you get `ReferenceError: RTCPeerConnection is not defined` on connect.

## Step 2 — the audio session (why the agent would otherwise hear itself)

A phone's loudspeaker is centimetres from its microphone. Unless the OS knows this is a two-way call, the raw speaker output goes straight back into the mic, the agent transcribes its own sentence and replies to it. Putting the session into *communication* mode turns on the hardware acoustic echo canceller:

```ts
await AudioSession.configureAudio({
  android: { audioTypeOptions: AndroidAudioTypePresets.communication },  // MODE_IN_COMMUNICATION
  ios: { defaultOutput: "speaker" },
});
if (Platform.OS === "ios") {
  await AudioSession.setAppleAudioConfiguration({
    audioCategory: "playAndRecord",
    audioCategoryOptions: ["allowBluetooth", "allowBluetoothA2DP", "defaultToSpeaker"],
    audioMode: "voiceChat",                 // ← enables AEC on iOS
  });
}
await AudioSession.startAudioSession();     // BEFORE room.connect()
```

Call `AudioSession.stopAudioSession()` when the call ends so music apps get their session back.

`defaultToSpeaker` makes the loudspeaker the default; a Bluetooth headset or wired earphones take precedence automatically when connected. For an earpiece-first phone-call feel, drop `defaultToSpeaker` and set `defaultOutput: "earpiece"`.

## Step 3 — `<LiveKitRoom>` + `useVoiceAssistant()`

```tsx
<LiveKitRoom serverUrl={creds.host} token={creds.token} connect audio video={false} onDisconnected={…}>
  <CallView />
</LiveKitRoom>

const { state, audioTrack } = useVoiceAssistant();   // listening | thinking | speaking | …
<BarVisualizer state={state} barCount={5} trackRef={audioTrack} options={{ barColor }} />
```

Remote audio plays automatically through the native audio session — there is no `<audio>` element to attach on mobile.

## Barge-in: red → green

`useAgentState()` returns `interrupting` when the local participant is an active speaker while the agent is still marked `speaking`. `COLORS` maps that to green and `speaking` to red, and the colour is passed to the visualizer's `barColor` and the status pill. Say something while the agent is mid-sentence and the bars flip green before the agent even finishes yielding.

## Troubleshooting

| symptom | fix |
| --- | --- |
| `RTCPeerConnection is not defined` | `registerGlobals()` is missing or runs after a Room was created |
| the app crashes on launch in Expo Go | expected — build a dev client (`npx expo run:ios`) |
| agent answers itself / echo | audio session not in communication mode: check `configureVoiceAudio()` runs before `connect` |
| no sound on iOS, everything else works | `UIBackgroundModes: ["audio"]` missing, or the session was stopped early |
| `Network request failed` on the token call | phone cannot reach your backend — use LAN IP or ngrok, and `usesCleartextTraffic` for plain http |
| Android: mic permission never prompts | `RECORD_AUDIO` must be in `app.json` **and** requested at runtime (`PermissionsAndroid.request`) |
