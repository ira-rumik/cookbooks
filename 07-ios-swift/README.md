# 07 · iOS native (Swift) — voice agent over WebRTC

SwiftUI + the LiveKit Swift SDK. The cookbook focuses on the two things enterprise iOS apps actually ask about: bridging LiveKit's delegate events into `@Published` state, and controlling **where the audio goes** (speaker, earpiece, AirPods, CarPlay).

```
┌───────────────┐  POST /api/token   ┌────────────────┐  POST /v1/webcall  ┌──────────┐
│ iOS app       │ ─────────────────▶ │ your backend   │ ─────────────────▶ │ Silk API │
│ (SwiftUI)     │ ◀───────────────── │ (shared/…)     │ ◀───────────────── │          │
└──────┬────────┘ {token,host,…}     └────────────────┘                    └──────────┘
       │  room.connect(url: host, token:) → setMicrophone(enabled: true) → agent audio via AVAudioSession
       └──────────────────── native WebRTC ─────────────▶ wss://livekit.rumik.ai ◀── agent joins
```

## What you get

| file | role |
| --- | --- |
| `SilkVoice/SilkAPI.swift` | `POST tokenURL` → `CallCredentials`; Silk error codes mapped to readable text |
| `SilkVoice/CallViewModel.swift` | **`RoomDelegate` → SwiftUI**: `@Published state`, barge-in detection, hang-up |
| `SilkVoice/AudioRouting.swift` | mic permission, speakerphone toggle, route-change observer, `AVRoutePickerView` wrapper |
| `SilkVoice/ContentView.swift` | coloured circle, status label, route picker, current output name |
| `Info.plist` | keys to merge: mic usage string, background audio, local networking |

## Run it

```bash
# 0. token backend (keeps the API key)
cd shared/token-server-node && cp .env.example .env && npm install && npm start     # :8787
```

1. Xcode → **File → New → Project → iOS App**, name it `SilkVoice`, interface SwiftUI. iOS 15+ deployment target.
2. **File → Add Package Dependencies…** → `https://github.com/livekit/client-sdk-swift` → **Up to Next Major** from `2.0.0`. Add the `LiveKit` product to the target.
3. Delete the generated `ContentView.swift` / `SilkVoiceApp.swift` and drag the five files from `SilkVoice/` into the target.
4. Target → **Info**: add `NSMicrophoneUsageDescription`; **Signing & Capabilities → Background Modes → Audio, AirPlay, and Picture in Picture**.
5. In `SilkAPI.swift` set `tokenURL` — simulator: `http://localhost:8787/api/token`; device: your LAN IP or an `ngrok http 8787` URL. For plain `http://` on a device, also merge the `NSAppTransportSecurity` block from `Info.plist`.
6. Run on a **physical device** — the simulator's microphone is not representative and has no echo path to test.

## The token backend

Any shared server works unchanged; the app only needs `POST /api/token` to return what `/v1/webcall` returned:

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

## Joining the room

```swift
let room = Room()
room.add(delegate: self)
try await room.connect(url: creds.host, token: creds.token)
try await room.localParticipant.setMicrophone(enabled: true)   // the agent greets as soon as it sees us
…
await room.disconnect()                                        // call ends, billing stops
```

Remote audio plays automatically through the active `AVAudioSession` route; there is nothing to attach.

## Bridging `RoomDelegate` into SwiftUI

Delegate callbacks arrive on LiveKit's queue; the view model is `@MainActor`, so each callback hops with `Task { @MainActor in … }`:

```swift
nonisolated func room(_ room: Room, participant: Participant, didUpdateIsSpeaking isSpeaking: Bool) {
    Task { @MainActor in
        if participant is LocalParticipant { userSpeaking = isSpeaking } else { agentSpeaking = isSpeaking }
        recompute()
    }
}
nonisolated func room(_ room: Room, participant: Participant, didUpdateAttributes attributes: [String: String]) {
    guard !(participant is LocalParticipant), let s = attributes["lk.agent.state"] else { return }
    Task { @MainActor in agentAttrState = s; recompute() }
}
nonisolated func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from _: ConnectionState) {
    Task { @MainActor in if connectionState == .disconnected { reset(); state = .idle } }
}
```

`recompute()` folds the three inputs into one `AgentUIState`: the agent's own `lk.agent.state` attribute when present, otherwise `isSpeaking`; and **`interrupting` when the local participant speaks while the agent is still marked as speaking** — that is barge-in, and the circle turns from red to green.

## OS-level audio routing

The SDK sets the session to `.playAndRecord` / `.voiceChat` when the call starts — that is what turns on hardware echo cancellation. Routing is yours:

| need | code |
| --- | --- |
| loudspeaker vs earpiece | `AudioManager.shared.isSpeakerOutputPreferred = true / false` |
| let the user pick AirPods / car / speaker | `AVRoutePickerView` (wrapped in `RoutePickerButton`) |
| show the current output | `AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portName)` |
| react when headphones connect/disconnect | observe `AVAudioSession.routeChangeNotification` (done in `CallViewModel.init`) |

A connected Bluetooth or wired device always wins over the built-in speaker/earpiece choice; the toggle only decides the built-in route.

If you need a fully custom session (e.g. mixing with music), set `AudioManager.shared.customConfigureAudioSessionFunc` before connecting — but keep mode `.voiceChat`, or the agent will hear itself.

## Troubleshooting

| symptom | fix |
| --- | --- |
| no prompt for the microphone, silent capture | `NSMicrophoneUsageDescription` missing → the OS silently denies |
| audio stops when the app goes to background | Background Modes → Audio not enabled |
| agent answers itself | custom session config without `.voiceChat`, or testing on the simulator |
| `App Transport Security` error on the token call | plain `http://` to a device — use ngrok https, or add `NSAllowsLocalNetworking` for dev |
| state stuck at Connecting… | the agent has not joined, or the token was already used — mint one per call |
