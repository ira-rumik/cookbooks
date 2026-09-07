"use client";

// useAgentState
//
// Wraps LiveKit's useVoiceAssistant() and adds two things every voice UI needs:
//
//   1. a fallback when the agent does not publish the `lk.agent.state`
//      attribute (useVoiceAssistant() would otherwise sit at "connecting"
//      forever) — we derive listening / speaking from active-speaker events;
//   2. an explicit "interrupting" state: the caller is talking while the
//      agent is still marked as speaking. That is barge-in, and the UI should
//      show it immediately, before the agent's audio actually stops.

import { useMemo } from "react";
import {
  useLocalParticipant,
  useRemoteParticipants,
  useSpeakingParticipants,
  useTracks,
  useVoiceAssistant,
} from "@livekit/components-react";
import { Track } from "livekit-client";

export type UiState =
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupting"
  | "disconnected";

export const STATE_LABELS: Record<UiState, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Agent speaking",
  interrupting: "You interrupted — go ahead",
  disconnected: "Disconnected",
};

export function useAgentState() {
  const assistant = useVoiceAssistant(); // { state, audioTrack, agent, agentTranscriptions }
  const remotes = useRemoteParticipants();
  const speakers = useSpeakingParticipants();
  const { localParticipant } = useLocalParticipant();
  const audioTracks = useTracks(
    [Track.Source.Microphone, Track.Source.Unknown],
    { onlySubscribed: true },
  );

  // The agent is the participant LiveKit flags as an agent; if it is not
  // flagged, the first remote participant in a 1:1 call is the agent.
  const agent = assistant.agent ?? remotes[0];

  const agentSpeaking = !!agent && speakers.some((p) => p.identity === agent.identity);
  const userSpeaking = speakers.some((p) => p.identity === localParticipant.identity);

  const audioTrack =
    assistant.audioTrack ??
    audioTracks.find(
      (t) =>
        t.participant.identity !== localParticipant.identity &&
        t.publication?.kind === Track.Kind.Audio,
    );

  const state = useMemo<UiState>(() => {
    let s: string = assistant.state;

    // Fallback: no lk.agent.state attribute, but the agent is in the room.
    if ((s === "connecting" || s === "initializing" || s === "disconnected") && agent) {
      s = agentSpeaking ? "speaking" : "listening";
    }
    if (s === "initializing") s = "connecting";

    // Barge-in: the caller speaks while the agent still counts as speaking.
    if (s === "speaking" && userSpeaking) return "interrupting";

    return s as UiState;
  }, [assistant.state, agent, agentSpeaking, userSpeaking]);

  return {
    state,
    agent,
    audioTrack,
    agentSpeaking,
    userSpeaking,
    transcriptions: assistant.agentTranscriptions,
  };
}
