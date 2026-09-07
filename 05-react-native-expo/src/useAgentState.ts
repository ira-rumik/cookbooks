// src/useAgentState.ts
//
// useVoiceAssistant() + two additions every voice UI needs:
//   1. a fallback when the agent does not publish `lk.agent.state`
//      (derive listening/speaking from active speakers);
//   2. an explicit "interrupting" state — the caller is talking while the
//      agent is still marked as speaking. That is barge-in.

import { useMemo } from "react";
import {
  useLocalParticipant,
  useRemoteParticipants,
  useSpeakingParticipants,
  useTracks,
  useVoiceAssistant,
} from "@livekit/components-react";
import { Track } from "livekit-client";

export type UiState = "connecting" | "listening" | "thinking" | "speaking" | "interrupting" | "disconnected";

export const COLORS: Record<UiState, string> = {
  connecting: "#a8a29e",
  disconnected: "#a8a29e",
  listening: "#a8a29e",
  thinking: "#f59e0b",
  speaking: "#dc2626",     // red: agent talking
  interrupting: "#16a34a", // green: you cut in
};

export const LABELS: Record<UiState, string> = {
  connecting: "Connecting…",
  disconnected: "Disconnected",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Agent speaking",
  interrupting: "You interrupted — go ahead",
};

export function useAgentState() {
  const assistant = useVoiceAssistant();
  const remotes = useRemoteParticipants();
  const speakers = useSpeakingParticipants();
  const { localParticipant } = useLocalParticipant();
  const audioTracks = useTracks([Track.Source.Microphone, Track.Source.Unknown], { onlySubscribed: true });

  const agent = assistant.agent ?? remotes[0];
  const agentSpeaking = !!agent && speakers.some((p) => p.identity === agent.identity);
  const userSpeaking = speakers.some((p) => p.identity === localParticipant.identity);

  const audioTrack =
    assistant.audioTrack ??
    audioTracks.find((t) => t.participant.identity !== localParticipant.identity && t.publication?.kind === Track.Kind.Audio);

  const state = useMemo<UiState>(() => {
    let s: string = assistant.state;
    if ((s === "connecting" || s === "initializing" || s === "disconnected") && agent) {
      s = agentSpeaking ? "speaking" : "listening";
    }
    if (s === "initializing") s = "connecting";
    if (s === "speaking" && userSpeaking) return "interrupting";
    return s as UiState;
  }, [assistant.state, agent, agentSpeaking, userSpeaking]);

  return { state, audioTrack, agent };
}
