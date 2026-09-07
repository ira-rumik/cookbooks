// App.tsx
//
// registerGlobals() MUST run before any LiveKit Room is created. It installs
// the native WebRTC engine's globals (RTCPeerConnection, MediaStream,
// WebSocket polyfills…) that livekit-client expects to find on `global`.
import { registerGlobals } from "@livekit/react-native";
registerGlobals();

import React from "react";
import { SafeAreaView, StatusBar, StyleSheet } from "react-native";
import { VoiceAgentScreen } from "./src/VoiceAgentScreen";

export default function App() {
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <VoiceAgentScreen />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: "#fafaf9" } });
