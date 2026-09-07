"use client";

// AgentPanel — everything inside <LiveKitRoom>.
//
// The BarVisualizer animates from the agent's audio track. Its bar colour is
// the CSS variable --lk-fg, which globals.css swaps per data-state:
//   listening  → grey     thinking → amber
//   speaking   → red      interrupting (barge-in) → green

import { BarVisualizer, useRoomContext } from "@livekit/components-react";
import { STATE_LABELS, useAgentState } from "./useAgentState";
import { Transcript } from "./Transcript";

export function AgentPanel({ callId }: { callId: string }) {
  const room = useRoomContext();
  const { state, audioTrack, transcriptions } = useAgentState();

  // BarVisualizer understands LiveKit's AgentState values only; our
  // "interrupting" state is purely visual, so map it back to "listening".
  const visualizerState = state === "interrupting" ? "listening" : state;

  return (
    <div className="card">
      <div className="row">
        <span className="status" data-state={state}>
          {STATE_LABELS[state]}
        </span>
        <span className="muted" style={{ fontSize: 12 }}>
          call {callId}
        </span>
        <span style={{ flex: 1 }} />
        <button className="secondary" onClick={() => room.disconnect()}>
          Hang up
        </button>
      </div>

      <div className="visualizer" data-state={state}>
        <BarVisualizer
          state={visualizerState}
          barCount={7}
          trackRef={audioTrack}
          options={{ minHeight: 16 }}
        />
      </div>

      <p className="muted" style={{ fontSize: 13, margin: 0 }}>
        Say something. Talk over the agent to see the bars turn green.
      </p>

      <Transcript segments={transcriptions} />
    </div>
  );
}
