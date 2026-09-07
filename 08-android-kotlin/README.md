# 08 · Android native (Kotlin) — voice agent over WebRTC

Jetpack Compose + `livekit-android`. The cookbook focuses on what native Android apps ask about: collecting LiveKit's `RoomEvent` flow into a `StateFlow` the UI can observe, putting the audio stack into call mode so the phone speaker does not feed the microphone, and switching between **Bluetooth headset / wired / earpiece / speaker** with the SDK's built-in AudioSwitch handler.

```
┌───────────────┐  POST /api/token   ┌────────────────┐  POST /v1/webcall  ┌──────────┐
│ Android app   │ ─────────────────▶ │ your backend   │ ─────────────────▶ │ Silk API │
│ (Compose)     │ ◀───────────────── │ (shared/…)     │ ◀───────────────── │          │
└──────┬────────┘ {token,host,…}     └────────────────┘                    └──────────┘
       │  room.connect(host, token) → setMicrophoneEnabled(true) → agent audio via AudioManager
       └──────────────────── native WebRTC ─────────────▶ wss://livekit.rumik.ai ◀── agent joins
```

## What you get

| file | role |
| --- | --- |
| `app/build.gradle.kts` | dependencies: `io.livekit:livekit-android`, Compose BOM, OkHttp |
| `app/src/main/AndroidManifest.xml` | `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `BLUETOOTH_CONNECT`, cleartext for dev |
| `…/SilkApi.kt` | `POST tokenUrl` → `CallCredentials`; Silk error codes mapped to readable text |
| `…/CallViewModel.kt` | **`RoomEvent` flow → `StateFlow<CallUi>`**: barge-in detection, `AudioType.CallAudioType` |
| `…/AudioRouting.kt` | wraps `AudioSwitchHandler`: list devices, select, speakerphone helper |
| `…/ui/CallScreen.kt` | coloured circle, status chip, hang-up, output-device dropdown |
| `…/MainActivity.kt` | runtime permission request, hosts the screen |

## Run it

```bash
# 0. token backend (keeps the API key)
cd shared/token-server-node && cp .env.example .env && npm install && npm start     # :8787
```

1. Android Studio → **New Project → Empty Activity (Compose)**, package `ai.rumik.silkvoice`, min SDK 24.
2. Replace `app/build.gradle.kts` dependencies with the ones in this folder (keep your generated plugin block if versions differ) and sync.
3. Replace `AndroidManifest.xml` and copy the Kotlin files under `app/src/main/java/ai/rumik/silkvoice/`.
4. In `SilkApi.kt` set `tokenUrl` — emulator: `http://10.0.2.2:8787/api/token`; device: your LAN IP or an `ngrok http 8787` https URL. `usesCleartextTraffic="true"` in the manifest allows plain http during development; remove it for release.
5. Run on a **physical device**. The emulator's microphone/speaker path does not exercise echo cancellation.

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

## Creating the Room in call mode

```kotlin
val room = LiveKit.create(
    appContext = app,
    options = RoomOptions(audioTrackCaptureDefaults = LocalAudioTrackOptions(echoCancellation = true, noiseSuppression = true, autoGainControl = true)),
    overrides = LiveKitOverrides(audioOptions = AudioOptions(audioOutputType = AudioType.CallAudioType())),
)
```

`AudioType.CallAudioType()` puts `AudioManager` into `MODE_IN_COMMUNICATION` with `USAGE_VOICE_COMMUNICATION`. That is the switch that enables the hardware acoustic echo canceller and routes the volume rocker to call volume. With the default `MediaAudioType` the agent hears its own voice from the loudspeaker and starts answering itself.

## Bridging `RoomEvent` into Compose

```kotlin
eventsJob = viewModelScope.launch { room.events.collect { onRoomEvent(it) } }   // before connect()
room.connect(creds.host, creds.token)
room.localParticipant.setMicrophoneEnabled(true)

private fun onRoomEvent(event: RoomEvent) = when (event) {
    is RoomEvent.ActiveSpeakersChanged -> { agentSpeaking = event.speakers.any { it is RemoteParticipant }
                                            userSpeaking  = event.speakers.any { it is LocalParticipant }; recompute() }
    is RoomEvent.ParticipantAttributesChanged -> event.changedAttributes["lk.agent.state"]?.let { agentAttrState = it; recompute() }
    is RoomEvent.Disconnected -> _ui.update { it.copy(state = IDLE, inCall = false) }
    else -> Unit
}
```

`recompute()` folds the inputs into one `AgentUiState`: the agent's own `lk.agent.state` attribute when present, otherwise active speakers; and **`INTERRUPTING` when the local participant speaks while the agent is still marked as speaking**. The UI collects `vm.ui` with `collectAsStateWithLifecycle()` and animates the circle colour: red for `SPEAKING`, green for `INTERRUPTING`.

## OS-level audio routing

`livekit-android` bundles Twilio's AudioSwitch. The `Room` exposes it as `room.audioHandler`:

```kotlin
val handler = room.audioHandler as AudioSwitchHandler
handler.availableAudioDevices          // [BluetoothHeadset("AirPods"), WiredHeadset, Earpiece, Speakerphone]
handler.selectedAudioDevice
handler.selectDevice(device)           // or null → automatic priority: Bluetooth > wired > earpiece > speaker
```

`AudioRouting.kt` wraps that for the UI, and `CallScreen` shows it as a dropdown. `BLUETOOTH_CONNECT` (API 31+) must be granted at runtime for headsets to appear — `MainActivity` requests it together with `RECORD_AUDIO`.

## Troubleshooting

| symptom | fix |
| --- | --- |
| agent answers itself / echo | `AudioType.CallAudioType()` missing, or testing on the emulator |
| no Bluetooth device in the list | `BLUETOOTH_CONNECT` not granted at runtime (API 31+) |
| `CLEARTEXT communication not permitted` | plain `http://` token URL without `usesCleartextTraffic="true"`; or use an https tunnel |
| `SecurityException: RECORD_AUDIO` | permission is declared but was not granted at runtime before `setMicrophoneEnabled(true)` |
| state stuck at Connecting… | the agent has not joined, or the token was already used — mint one per call |
