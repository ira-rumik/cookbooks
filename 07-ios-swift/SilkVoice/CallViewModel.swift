// CallViewModel.swift — bridges LiveKit's RoomDelegate into SwiftUI state.
//
// UI state machine:
//   idle → connecting → listening ⇄ thinking ⇄ speaking → (interrupting) → … → idle
//
// `speaking` is red; `interrupting` (the caller talks over the agent) is
// green. State comes from the agent's `lk.agent.state` attribute when it
// publishes one, and from isSpeaking updates otherwise.

import AVFoundation
import Foundation
import LiveKit

enum AgentUIState: String {
    case idle, connecting, listening, thinking, speaking, interrupting, error

    var label: String {
        switch self {
        case .idle: return "Idle"
        case .connecting: return "Connecting…"
        case .listening: return "Listening"
        case .thinking: return "Thinking"
        case .speaking: return "Agent speaking"
        case .interrupting: return "You interrupted — go ahead"
        case .error: return "Error"
        }
    }
}

private let agentStateAttribute = "lk.agent.state"

@MainActor
final class CallViewModel: ObservableObject {
    @Published private(set) var state: AgentUIState = .idle
    @Published private(set) var errorMessage: String?
    @Published private(set) var callId: String?
    @Published private(set) var outputRoute: String = AudioRouting.currentOutputName()
    @Published var speakerphone = true {
        didSet { AudioRouting.setSpeakerphone(speakerphone) }
    }

    let room = Room()

    private var agentAttrState: String?
    private var agentSpeaking = false
    private var userSpeaking = false
    private var routeObserver: NSObjectProtocol?

    var inCall: Bool { room.connectionState == .connected || room.connectionState == .reconnecting }

    init() {
        room.add(delegate: self)
        // Bluetooth headphones connect, CarPlay takes over, user pulls out the
        // wired earphones… keep the label honest.
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.outputRoute = AudioRouting.currentOutputName() }
        }
    }

    func start() async {
        errorMessage = nil
        state = .connecting
        do {
            // 1. Microphone permission first: /v1/webcall bills the moment it returns.
            guard await AudioRouting.requestMicrophonePermission() else {
                throw SilkAPIError(status: 0, code: "mic_denied", message: "Microphone permission denied.")
            }
            // 2. Credentials from your backend.
            let creds = try await SilkAPI.startCall()
            callId = creds.callId

            // 3. Join and publish the microphone. The agent greets as soon as it sees us.
            try await room.connect(url: creds.host, token: creds.token)
            try await room.localParticipant.setMicrophone(enabled: true)
            AudioRouting.setSpeakerphone(speakerphone)

            // 4. The agent may already be in the room with a state attribute.
            for participant in room.remoteParticipants.values {
                if let s = participant.attributes[agentStateAttribute] { agentAttrState = s }
            }
            recompute()
        } catch {
            errorMessage = error.localizedDescription
            state = .error
            await room.disconnect()
        }
    }

    func hangUp() async {
        await room.disconnect() // → didUpdateConnectionState(.disconnected) → idle; billing stops
    }

    private func recompute() {
        var s: AgentUIState
        switch agentAttrState {
        case "speaking": s = .speaking
        case "thinking": s = .thinking
        case "listening": s = .listening
        case "initializing": s = .connecting
        default: s = agentSpeaking ? .speaking : .listening // no attribute → who is making noise
        }
        // Barge-in: the caller speaks while the agent still counts as speaking.
        if s == .speaking, userSpeaking { s = .interrupting }
        state = s
    }

    private func reset() {
        agentAttrState = nil
        agentSpeaking = false
        userSpeaking = false
    }
}

// MARK: - RoomDelegate → SwiftUI

extension CallViewModel: RoomDelegate {
    nonisolated func room(_ room: Room, participant: Participant, didUpdateIsSpeaking isSpeaking: Bool) {
        Task { @MainActor in
            if participant is LocalParticipant { userSpeaking = isSpeaking } else { agentSpeaking = isSpeaking }
            recompute()
        }
    }

    nonisolated func room(_ room: Room, participant: Participant, didUpdateAttributes attributes: [String: String]) {
        guard !(participant is LocalParticipant), let s = attributes[agentStateAttribute] else { return }
        Task { @MainActor in
            agentAttrState = s
            recompute()
        }
    }

    nonisolated func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) {
        Task { @MainActor in
            switch connectionState {
            case .disconnected:
                reset()
                if state != .error { state = .idle }
            case .connecting, .reconnecting:
                state = .connecting
            case .connected:
                recompute()
            }
        }
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        // Remote audio plays through the active AVAudioSession route automatically.
    }
}
