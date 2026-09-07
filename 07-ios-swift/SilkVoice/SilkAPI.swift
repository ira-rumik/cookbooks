// SilkAPI.swift — the only call the app makes to *your* backend.
//
//   POST <tokenURL>  ->  { token, host, roomName, callId }
//
// The backend (see ../shared/token-server-node) holds the rk_live_ key and
// calls Silk's /v1/webcall. The app never sees the key.

import Foundation

struct CallCredentials: Decodable {
    let token: String
    let host: String
    let roomName: String?
    let callId: String?
}

struct SilkAPIError: LocalizedError {
    let status: Int
    let code: String
    let message: String

    private static let friendly: [String: String] = [
        "agent_not_deployed": "The agent has not been deployed yet — press Deploy in the dashboard.",
        "insufficient_balance": "The account cannot fund a call right now.",
        "concurrency_limit_exceeded": "All call slots are busy. Try again in a moment.",
    ]

    var errorDescription: String? { Self.friendly[code] ?? "\(status) \(code): \(message)" }
}

enum SilkAPI {
    /// Simulator: localhost. Device: your LAN IP or an ngrok https URL.
    static var tokenURL = URL(string: "http://localhost:8787/api/token")!

    static func startCall() async throws -> CallCredentials {
        var req = URLRequest(url: tokenURL)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)

        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            struct Envelope: Decodable { let error: String?; let code: String? }
            let env = (try? JSONDecoder().decode(Envelope.self, from: data)) ?? Envelope(error: nil, code: nil)
            throw SilkAPIError(status: status, code: env.code ?? "error", message: env.error ?? "token request failed")
        }
        return try JSONDecoder().decode(CallCredentials.self, from: data)
    }
}
