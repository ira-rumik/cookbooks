// AudioRouting.swift — OS-level audio routing: speakerphone, earpiece, Bluetooth.
//
// LiveKit's Swift SDK configures AVAudioSession for you when a call starts:
// category .playAndRecord, mode .voiceChat — which is what turns on the
// hardware acoustic echo canceller so the agent does not hear itself out of
// the iPhone speaker. What is left to you is *where* the audio goes.

import AVFoundation
import AVKit
import LiveKit
import SwiftUI

enum AudioRouting {
    /// Ask for the microphone BEFORE starting a (billed) call.
    static func requestMicrophonePermission() async -> Bool {
        if #available(iOS 17, *) {
            return await AVAudioApplication.requestRecordPermission()
        }
        return await withCheckedContinuation { cont in
            AVAudioSession.sharedInstance().requestRecordPermission { cont.resume(returning: $0) }
        }
    }

    /// "Speaker", "AirPods Pro", "Receiver", "Headphones", "CarPlay"…
    static func currentOutputName() -> String {
        AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portName).joined(separator: ", ")
    }

    /// Loudspeaker (true) vs earpiece (false). A connected Bluetooth or wired
    /// device takes precedence over both automatically; this only decides the
    /// built-in route.
    static func setSpeakerphone(_ on: Bool) {
        AudioManager.shared.isSpeakerOutputPreferred = on
    }
}

/// Apple's own route picker (AirPods, car, speaker…). Zero UI to maintain and
/// it lists exactly what the OS can route to right now.
struct RoutePickerButton: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.prioritizesVideoDevices = false
        view.tintColor = UIColor(red: 0.76, green: 0.25, blue: 0.05, alpha: 1)
        return view
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}
