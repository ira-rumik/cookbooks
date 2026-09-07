// src/VoiceAgentScreen.tsx

import React, { useCallback, useState } from "react";
import { PermissionsAndroid, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { BarVisualizer, LiveKitRoom } from "@livekit/react-native";
import { useRoomContext } from "@livekit/components-react";
import { CallCredentials, startCall } from "./api";
import { configureVoiceAudio, releaseVoiceAudio } from "./audio";
import { COLORS, LABELS, useAgentState } from "./useAgentState";

async function ensureMicPermission(): Promise<void> {
  if (Platform.OS !== "android") return; // iOS prompts on first capture
  const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
  if (r !== PermissionsAndroid.RESULTS.GRANTED) throw new Error("Microphone permission denied.");
}

export function VoiceAgentScreen() {
  const [creds, setCreds] = useState<CallCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await ensureMicPermission();     // 1. permission first: /v1/webcall bills the moment it returns
      await configureVoiceAudio();     // 2. echo-safe audio session, BEFORE connecting
      setCreds(await startCall());     // 3. credentials from your backend
    } catch (e) {
      setError((e as Error).message);
      await releaseVoiceAudio().catch(() => {});
    } finally {
      setBusy(false);
    }
  }, []);

  const onDisconnected = useCallback(() => {
    setCreds(null);
    releaseVoiceAudio().catch(() => {});
  }, []);

  if (!creds) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Silk voice agent</Text>
        <Text style={styles.muted}>React Native · Expo · WebRTC</Text>
        <Pressable style={[styles.button, busy && styles.disabled]} onPress={start} disabled={busy}>
          <Text style={styles.buttonText}>{busy ? "Starting…" : "Start call"}</Text>
        </Pressable>
        {error && <Text style={styles.error}>{error}</Text>}
      </View>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={creds.host}
      token={creds.token}
      connect
      audio                      // publish the microphone as soon as we are in
      video={false}
      onDisconnected={onDisconnected}
      onError={(e) => setError(e.message)}
    >
      <CallView callId={creds.callId} error={error} />
    </LiveKitRoom>
  );
}

function CallView({ callId, error }: { callId: string; error: string | null }) {
  const room = useRoomContext();
  const { state, audioTrack } = useAgentState();
  const color = COLORS[state];
  const visualizerState = state === "interrupting" ? "listening" : state;

  return (
    <View style={styles.center}>
      <View style={[styles.pill, { borderColor: color }]}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text>{LABELS[state]}</Text>
      </View>

      {/* Bars animate from the agent's audio track; colour follows the state. */}
      <BarVisualizer
        state={visualizerState}
        barCount={5}
        trackRef={audioTrack}
        options={{ minHeight: 24, maxHeight: 120, barColor: color }}
        style={styles.visualizer}
      />

      <Text style={styles.muted}>Talk over the agent to see the bars turn green.</Text>
      <Text style={[styles.muted, { fontSize: 12 }]}>call {callId}</Text>

      <Pressable style={[styles.button, styles.secondary]} onPress={() => room.disconnect()}>
        <Text>Hang up</Text>
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  title: { fontSize: 24, fontWeight: "600", color: "#1c1917" },
  muted: { color: "#78716c" },
  button: { backgroundColor: "#c2410c", paddingHorizontal: 24, paddingVertical: 12, borderRadius: 999 },
  secondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#e7e5e4" },
  buttonText: { color: "white", fontWeight: "600" },
  disabled: { opacity: 0.5 },
  pill: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  visualizer: { width: 240, height: 140 },
  error: { color: "#7f1d1d", backgroundColor: "#fee2e2", padding: 12, borderRadius: 10 },
});
