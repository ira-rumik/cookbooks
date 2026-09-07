// lib/silk_api.dart — the only call the app makes to *your* backend.
//
//   POST $TOKEN_URL  ->  { token, host, roomName, callId }
//
// The backend (see ../shared/token-server-node) holds the rk_live_ key and
// calls Silk's /v1/webcall. The app never sees the key.
//
// Pass the URL at build time:  flutter run --dart-define=TOKEN_URL=http://10.0.2.2:8787/api/token

import 'dart:convert';

import 'package:http/http.dart' as http;

class CallCredentials {
  const CallCredentials({required this.token, required this.host, required this.roomName, required this.callId});

  final String token;
  final String host;
  final String roomName;
  final String callId;

  factory CallCredentials.fromJson(Map<String, dynamic> j) => CallCredentials(
        token: j['token'] as String,
        host: j['host'] as String,
        roomName: j['roomName'] as String? ?? '',
        callId: j['callId'] as String? ?? '',
      );
}

class SilkApiException implements Exception {
  SilkApiException(this.status, this.code, this.message);
  final int status;
  final String code;
  final String message;

  static const _friendly = {
    'agent_not_deployed': 'The agent has not been deployed yet — press Deploy in the dashboard.',
    'insufficient_balance': 'The account cannot fund a call right now.',
    'concurrency_limit_exceeded': 'All call slots are busy. Try again in a moment.',
  };

  @override
  String toString() => _friendly[code] ?? '$status $code: $message';
}

class SilkApi {
  static const tokenUrl = String.fromEnvironment(
    'TOKEN_URL',
    defaultValue: 'http://localhost:8787/api/token',
  );

  static Future<CallCredentials> startCall() async {
    final res = await http.post(
      Uri.parse(tokenUrl),
      headers: {'Content-Type': 'application/json'},
      body: '{}',
    );
    final body = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode != 200) {
      throw SilkApiException(res.statusCode, body['code'] as String? ?? 'error', body['error'] as String? ?? res.body);
    }
    return CallCredentials.fromJson(body);
  }
}
