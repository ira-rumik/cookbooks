# 01 · React / Next.js — voice agent over WebRTC

Talk to a Silk voice agent from a Next.js (App Router) page using `@livekit/components-react`. The API key stays in a Route Handler; the browser only ever sees a short-lived LiveKit token.

```
┌─────────────┐  POST /api/token   ┌──────────────────────┐  POST /v1/webcall  ┌──────────┐
│  browser    │ ─────────────────▶ │ Next.js Route Handler│ ─────────────────▶ │ Silk API │
│  (React)    │ ◀───────────────── │  app/api/token       │ ◀───────────────── │          │
└──────┬──────┘ {token,host,…}     └──────────────────────┘ {token,host,…}     └──────────┘
       │
       │  room.connect(host, token)  ── WebRTC ──▶  wss://livekit.rumik.ai  ◀── agent joins, greets
       └──────────────────────────────────────────────────────────────────────────────────────▶
```

## What you get

| file | role |
| --- | --- |
| `app/api/token/route.ts` | **the token backend** — calls `/v1/webcall` with `RUMIK_API_KEY`, forwards `{ token, host, roomName, callId }` and Silk's error envelope |
| `components/VoiceAgent.tsx` | asks for the mic, fetches credentials, mounts `<LiveKitRoom>` |
| `components/useAgentState.ts` | `useVoiceAssistant()` + active-speaker fallback + the `interrupting` state |
| `components/AgentPanel.tsx` | status pill, `<BarVisualizer>` that changes colour per state, hang-up |
| `components/Transcript.tsx` | renders agent transcriptions when the agent publishes them |
| `app/globals.css` | the four state colours (grey / amber / red / green) |

## Run it

```bash
cd 01-nextjs-webrtc
cp .env.example .env.local        # RUMIK_API_KEY, RUMIK_AGENT_ID
npm install
npm run dev                       # http://localhost:3000
```

Press **Start call**, allow the microphone, and the agent greets you.

## The token backend

`app/api/token/route.ts` is the entire server side. Note `dynamic = "force-dynamic"` — Next.js must never cache this response, every call needs fresh credentials.

```ts
export async function POST() {
  const upstream = await fetch(`${BASE}/v1/webcall`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RUMIK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: process.env.RUMIK_AGENT_ID }),
    cache: "no-store",
  });
  const body = await upstream.json();
  return NextResponse.json(body, { status: upstream.status }); // forward { error, code } as-is
}
```

`/v1/webcall` **starts the call** (and billing) when it returns, so the client asks for microphone permission first and only then hits this route.

## Wrapping the UI in `<LiveKitRoom>`

```tsx
<LiveKitRoom serverUrl={creds.host} token={creds.token} connect audio video={false}
             onDisconnected={() => setCreds(null)}>
  <RoomAudioRenderer />           {/* plays the agent's audio track */}
  <StartAudio label="Click to enable audio" />
  <AgentPanel callId={creds.callId} />
</LiveKitRoom>
```

`audio` (or an `AudioCaptureOptions` object) publishes the microphone as soon as the room connects. Hang up with `useRoomContext().disconnect()`; the call ends and billing stops.

## `useVoiceAssistant()` and the visualizer

```tsx
const { state, audioTrack, agentTranscriptions } = useVoiceAssistant();
// state: "connecting" | "initializing" | "listening" | "thinking" | "speaking" | "disconnected"

<BarVisualizer state={state} barCount={7} trackRef={audioTrack} options={{ minHeight: 16 }} />
```

`state` comes from the `lk.agent.state` attribute on the agent participant. `useAgentState()` in this cookbook adds a fallback — if the attribute is not there, it derives `listening` / `speaking` from `useSpeakingParticipants()` so the UI never sits at "connecting" with a talking agent.

## Barge-in: red → green

Over WebRTC the agent stops itself when the caller talks over it; the client only needs to *show* it. `useAgentState()` returns `interrupting` when the local participant is an active speaker while the agent is still marked `speaking`:

```ts
if (s === "speaking" && userSpeaking) return "interrupting";
```

`AgentPanel` puts that state on a `data-state` attribute, and `globals.css` swaps the visualizer colour:

```css
.visualizer[data-state="speaking"]     { --lk-fg: #dc2626; }  /* red   */
.visualizer[data-state="interrupting"] { --lk-fg: #16a34a; }  /* green */
```

Try it: wait until the agent is mid-sentence and start talking. The bars flip to green immediately, then the agent yields and you are back to grey (`listening`).

## Where the call shows up

`callId` from `/api/token` is the id you will find under **conversations** in the dashboard (transcript + recording). Store it alongside your own user/session id if you need to correlate later.

## Troubleshooting

| symptom | cause / fix |
| --- | --- |
| `409 agent_not_deployed` | press **Deploy** in the dashboard; saving alone is a draft |
| `429 concurrency_limit_exceeded` | every slot is busy; `GET /v1/agent/limits` shows the numbers |
| silence, "Click to enable audio" visible | browser autoplay policy — one click on `<StartAudio>` fixes it |
| state stuck at "Connecting…" | the agent has not joined yet, or the token was already used (mint a fresh one per call) |
| agent hears itself | you are on speakers without echo cancellation; keep `echoCancellation: true` or use headphones |
