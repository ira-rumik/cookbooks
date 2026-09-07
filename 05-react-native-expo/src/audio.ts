// src/audio.ts — the part that makes mobile voice *not* echo.
//
// A phone's speaker sits centimetres from its microphone. Unless the OS is told
// this is a two-way call, the agent hears its own voice come back, transcribes
// it, and answers itself. The fix is to put the audio session into the
// platform's "communication" mode, which turns on the hardware acoustic echo
// canceller (AEC):
//
//   iOS     -> AVAudioSession category .playAndRecord, mode .voiceChat
//   Android -> AudioManager MODE_IN_COMMUNICATION, usage VOICE_COMMUNICATION
//
// Do this BEFORE room.connect(); changing it mid-call re-opens the audio units.

import { Platform } from "react-native";
import { AndroidAudioTypePresets, AudioSession } from "@livekit/react-native";

export async function configureVoiceAudio(): Promise<void> {
  await AudioSession.configureAudio({
    android: {
      // MODE_IN_COMMUNICATION + VOICE_COMMUNICATION usage: hardware AEC, call volume rocker
      audioTypeOptions: AndroidAudioTypePresets.communication,
    },
    ios: {
      defaultOutput: "speaker", // loudspeaker by default; Bluetooth / wired take over automatically
    },
  });

  if (Platform.OS === "ios") {
    await AudioSession.setAppleAudioConfiguration({
      audioCategory: "playAndRecord",
      audioCategoryOptions: ["allowBluetooth", "allowBluetoothA2DP", "defaultToSpeaker"],
      audioMode: "voiceChat", // <- this is what enables echo cancellation on iOS
    });
  }

  await AudioSession.startAudioSession();
}

export async function releaseVoiceAudio(): Promise<void> {
  await AudioSession.stopAudioSession();
}
