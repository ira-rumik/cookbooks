# 06 · Flutter — voice agent over WebRTC

Talk to the Silk agent from iOS and Android with `livekit_client`, with state managed by a plain `ChangeNotifier`. LiveKit's Flutter SDK puts the platform audio session into voice-call mode for you, so echo cancellation on the phone speaker works out of the box.

```
┌───────────────┐  POST /api/token   ┌────────────────┐  POST /v1/webcall  ┌──────────┐
│ Flutter app   │ ─────────────────▶ │ your backend   │ ─────────────────▶ │ Silk API │
│ (iOS/Android) │ ◀───────────────── │ (shared/…)     │ ◀───────────────── │          │
└──────┬────────┘ {token,host,…}     └────────────────┘                    └──────────┘
       │  Room.connect(host, token) → setMicrophoneEnabled(true) → agent audio plays automatically
       └──────────────────── native WebRTC ─────────────▶ wss://livekit.rumik.ai ◀── agent joins
```

## What you get

| file | role |
| --- | --- |
| `lib/silk_api.dart` | `POST TOKEN_URL` → `CallCredentials`, Silk error codes mapped to readable text |
| `lib/silk_call_controller.dart` | **the `ChangeNotifier`**: permission → credentials → `Room` → events → `AgentUiState` |
| `lib/main.dart` | a `ListenableBuilder` UI: coloured circle, status chip, hang-up, speakerphone toggle |
| `platform/ios-Info.plist-additions.xml` | mic permission string + background audio |
| `platform/AndroidManifest-additions.xml` | mic / audio / Bluetooth permissions |

## Run it

```bash
# 0. token backend (keeps the API key)
cd shared/token-server-node && cp .env.example .env && npm install && npm start     # :8787

# 1. create a Flutter project and drop this cookbook in
flutter create --org ai.rumik --platforms ios,android silk_voice_flutter
cd silk_voice_flutter
cp -r ../06-flutter/lib ./lib
cp ../06-flutter/pubspec.yaml ./pubspec.yaml
flutter pub get

# 2. permissions (see platform/)
#    - paste platform/ios-Info.plist-additions.xml into ios/Runner/Info.plist
#    - paste platform/AndroidManifest-additions.xml into android/app/src/main/AndroidManifest.xml
#    - android/app/build.gradle: minSdk = 21 or higher
#    - ios/Podfile: platform :ios, '13.0' or higher

# 3. run on a physical device (simulators have no useful microphone)
flutter run --dart-define=TOKEN_URL=http://<your-LAN-IP>:8787/api/token
#   Android emulator: TOKEN_URL=http://10.0.2.2:8787/api/token
#   iOS simulator:    TOKEN_URL=http://localhost:8787/api/token
```

## The token backend

Any of the shared servers works unchanged; the app only needs `POST /api/token` to return what `/v1/webcall` returned:

```python
@app.post("/api/token")
async def token():
    r = await http.post(f"{BASE}/v1/webcall", headers={"Authorization": f"Bearer {API_KEY}"}, json={"agentId": AGENT_ID})
    return JSONResponse(status_code=r.status_code, content=r.json())   # {token, host, roomName, callId}
```

## Connecting to the room

```dart
final room = Room(roomOptions: const RoomOptions(
  defaultAudioCaptureOptions: AudioCaptureOptions(echoCancellation: true, noiseSuppression: true, autoGainControl: true),
));
final listener = room.createListener()
  ..on<ActiveSpeakersChangedEvent>((e) { … })
  ..on<ParticipantAttributesChanged>((e) { … })
  ..on<RoomDisconnectedEvent>((e) { … });

await room.connect(creds.host, creds.token);
await room.localParticipant?.setMicrophoneEnabled(true);
await Hardware.instance.setSpeakerphoneOn(true);   // loudspeaker; Bluetooth/wired take over automatically
```

Remote audio tracks play automatically on mobile — there is nothing to attach. Hang up with `room.disconnect()`; the call ends and billing stops.

## State with `ChangeNotifier`

`SilkCallController` keeps three inputs and recomputes one output:

```dart
// input 1: the agent's own state attribute, when it publishes one
..on<ParticipantAttributesChanged>((e) { _agentAttrState = e.attributes['lk.agent.state']; _recompute(); })
// input 2 + 3: who is making noise right now
..on<ActiveSpeakersChangedEvent>((e) {
  _agentSpeaking = e.speakers.any((p) => p is RemoteParticipant);
  _userSpeaking  = e.speakers.any((p) => p is LocalParticipant);
  _recompute();
})

void _recompute() {
  var s = switch (_agentAttrState) { 'speaking' => speaking, 'thinking' => thinking, 'listening' => listening,
                                     _ => _agentSpeaking ? speaking : listening };
  if (s == speaking && _userSpeaking) s = interrupting;   // ← barge-in
  _set(s);
}
```

The widget tree subscribes with `ListenableBuilder(listenable: controller, …)` — no extra state-management package needed. Swap in Provider/Riverpod if your app already uses one; the controller does not care.

## Barge-in: red → green

`AgentUiState.speaking` paints the circle red; `interrupting` paints it green the moment the caller is an active speaker while the agent is still marked as speaking. The agent itself stops server-side — the app only reflects it.

## Troubleshooting

| symptom | fix |
| --- | --- |
| `MissingPluginException` / build errors | run `flutter clean && flutter pub get`, then `cd ios && pod install` |
| iOS build: "deployment target" errors | set `platform :ios, '13.0'` in `ios/Podfile` |
| Android build: minSdk error | `minSdk = 21` in `android/app/build.gradle` |
| agent hears itself | `echoCancellation: true` in `AudioCaptureOptions` (default here); test on a real device, not an emulator |
| `SocketException` on the token call | phone cannot reach your backend — LAN IP / ngrok; `usesCleartextTraffic` for plain http on Android |
| state stuck at `connecting` | the agent has not joined yet, or the token was already used (mint one per call) |
