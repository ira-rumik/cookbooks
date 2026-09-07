"use client";

// VoiceAgent — the entry point.
//
//   1. ask for the microphone BEFORE starting the call (the call is billed the
//      moment /api/token returns, so do not start one you cannot join);
//   2. POST /api/token → { token, host, roomName, callId };
//   3. render <LiveKitRoom> with those credentials. RoomAudioRenderer plays
//      every remote audio track, so the agent is audible with zero extra code.

import { useCallback, useState } from "react";
import { LiveKitRoom, RoomAudioRenderer, StartAudio } from "@livekit/components-react";
import "@livekit/components-styles";
import { AgentPanel } from "./AgentPanel";

type CallCredentials = { token: string; host: string; roomName: string; callId: string };

const FRIENDLY: Record<string, string> = {
  agent_not_deployed: "The agent has not been deployed yet — press Deploy in the dashboard.",
  insufficient_balance: "Your Silk balance cannot fund a call right now.",
  concurrency_limit_exceeded: "All concurrent call slots are busy. Try again in a moment.",
  not_configured: "The server is missing RUMIK_API_KEY / RUMIK_AGENT_ID.",
};

async function ensureMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // LiveKit will open its own track
  } catch (err) {
    const name = (err as DOMException).name;
    if (name === "NotAllowedError") throw new Error("Microphone permission denied. Allow it in the address bar and retry.");
    if (name === "NotFoundError") throw new Error("No microphone found.");
    throw err;
  }
}

export default function VoiceAgent() {
  const [creds, setCreds] = useState<CallCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await ensureMicrophone();

      const res = await fetch("/api/token", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(FRIENDLY[body.code] ?? `${res.status} ${body.code}: ${body.error}`);
      }
      setCreds(body as CallCredentials);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  if (!creds) {
    return (
      <div className="card">
        <button onClick={start} disabled={busy}>
          {busy ? "Starting…" : "Start call"}
        </button>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={creds.host}
      token={creds.token}
      connect
      audio={{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }}
      video={false}
      onDisconnected={() => setCreds(null)}
      onError={(e) => setError(e.message)}
    >
      {/* Plays every remote audio track — the agent's voice. */}
      <RoomAudioRenderer />
      {/* Shown only if the browser blocked autoplay; one click unblocks it. */}
      <StartAudio label="Click to enable audio" />
      <AgentPanel callId={creds.callId} />
      {error && <div className="error">{error}</div>}
    </LiveKitRoom>
  );
}
