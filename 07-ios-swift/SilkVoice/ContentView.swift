// ContentView.swift
import SwiftUI

struct ContentView: View {
    @StateObject private var vm = CallViewModel()

    private func color(for s: AgentUIState) -> Color {
        switch s {
        case .thinking: return Color(red: 0.96, green: 0.62, blue: 0.04)
        case .speaking: return Color(red: 0.86, green: 0.15, blue: 0.15)      // red: agent talking
        case .interrupting: return Color(red: 0.09, green: 0.64, blue: 0.29)  // green: you cut in
        case .error: return Color(red: 0.5, green: 0.11, blue: 0.11)
        default: return Color(.systemGray3)
        }
    }

    var body: some View {
        VStack(spacing: 24) {
            Text("Silk voice agent").font(.title2.bold())
            Text("SwiftUI · LiveKit · WebRTC").foregroundStyle(.secondary)

            // The "visualizer": a circle whose colour follows the state and that
            // swells while someone is talking.
            let talking = vm.state == .speaking || vm.state == .interrupting
            Circle()
                .fill(color(for: vm.state))
                .frame(width: talking ? 150 : 120, height: talking ? 150 : 120)
                .animation(.easeInOut(duration: 0.15), value: vm.state)

            Label(vm.state.label, systemImage: "circle.fill")
                .labelStyle(.titleAndIcon)
                .foregroundStyle(color(for: vm.state))

            if let callId = vm.callId {
                Text("call \(callId)").font(.caption).foregroundStyle(.secondary)
            }
            if let err = vm.errorMessage {
                Text(err).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center).padding(.horizontal)
            }

            if vm.inCall {
                HStack(spacing: 16) {
                    Button("Hang up") { Task { await vm.hangUp() } }
                        .buttonStyle(.bordered)
                    Toggle(isOn: $vm.speakerphone) { Image(systemName: vm.speakerphone ? "speaker.wave.2.fill" : "phone.fill") }
                        .toggleStyle(.button)
                    RoutePickerButton().frame(width: 44, height: 44)   // AirPods / car / speaker
                }
                Text("Output: \(vm.outputRoute)").font(.caption).foregroundStyle(.secondary)
            } else {
                Button(vm.state == .connecting ? "Starting…" : "Start call") { Task { await vm.start() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(vm.state == .connecting)
            }

            Text("Talk over the agent to see the circle turn green.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .padding()
    }
}

#Preview { ContentView() }
