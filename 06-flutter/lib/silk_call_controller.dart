// lib/silk_call_controller.dart — a ChangeNotifier that owns the LiveKit Room.
//
// UI state machine:
//   idle → connecting → listening ⇄ thinking ⇄ speaking → (interrupting) → … → idle
//
// `speaking` is red, `interrupting` (the caller talks over the agent) is
// green. State comes from the agent's `lk.agent.state` attribute when it
// publishes one, and from active-speaker events otherwise.

import 'package:flutter/foundation.dart';
import 'package:livekit_client/livekit_client.dart';
import 'package:permission_handler/permission_handler.dart';

import 'silk_api.dart';

enum AgentUiState { idle, connecting, listening, thinking, speaking, interrupting, error }

const _agentStateAttr = 'lk.agent.state';

class SilkCallController extends ChangeNotifier {
  AgentUiState state = AgentUiState.idle;
  String? error;
  String? callId;
  bool speakerphone = true;

  Room? _room;
  EventsListener<RoomEvent>? _listener;
  String? _agentAttrState;
  bool _agentSpeaking = false;
  bool _userSpeaking = false;

  bool get inCall => _room != null;

  Future<void> start() async {
    if (_room != null) return;
    error = null;

    // 1. Microphone permission FIRST — /v1/webcall bills the moment it returns,
    //    so never start a call the user cannot join.
    final mic = await Permission.microphone.request();
    if (!mic.isGranted) {
      _fail('Microphone permission denied.');
      return;
    }

    _set(AgentUiState.connecting);
    try {
      // 2. Credentials from your backend.
      final creds = await SilkApi.startCall();
      callId = creds.callId;

      // 3. A Room with echo cancellation on. LiveKit puts the platform audio
      //    session into voice-call mode for you (AVAudioSession .voiceChat on
      //    iOS, MODE_IN_COMMUNICATION on Android) so the mic does not hear the speaker.
      final room = Room(
        roomOptions: const RoomOptions(
          adaptiveStream: true,
          dynacast: true,
          defaultAudioCaptureOptions: AudioCaptureOptions(
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          ),
        ),
      );

      _listener = room.createListener()
        ..on<ActiveSpeakersChangedEvent>((e) {
          _agentSpeaking = e.speakers.any((p) => p is RemoteParticipant);
          _userSpeaking = e.speakers.any((p) => p is LocalParticipant);
          _recompute();
        })
        ..on<ParticipantAttributesChanged>((e) {
          if (e.participant is! RemoteParticipant) return;
          final s = e.attributes[_agentStateAttr];
          if (s != null) {
            _agentAttrState = s;
            _recompute();
          }
        })
        ..on<TrackSubscribedEvent>((e) {
          // Remote audio tracks play automatically; nothing to attach on mobile.
          debugPrint('subscribed to ${e.track.kind} from ${e.participant.identity}');
        })
        ..on<RoomDisconnectedEvent>((e) {
          debugPrint('disconnected: ${e.reason}');
          _cleanup();
          _set(AgentUiState.idle);
        });

      // 4. Join and publish the microphone. The agent greets as soon as it sees us.
      await room.connect(creds.host, creds.token);
      await room.localParticipant?.setMicrophoneEnabled(true);
      await Hardware.instance.setSpeakerphoneOn(speakerphone);
      _room = room;

      // The agent may already be in the room with a state attribute.
      for (final p in room.remoteParticipants.values) {
        final s = p.attributes[_agentStateAttr];
        if (s != null) _agentAttrState = s;
      }
      _recompute();
    } catch (e) {
      _cleanup();
      _fail(e.toString());
    }
  }

  Future<void> hangUp() async {
    await _room?.disconnect(); // fires RoomDisconnectedEvent → idle; billing stops
  }

  Future<void> toggleSpeakerphone() async {
    speakerphone = !speakerphone;
    await Hardware.instance.setSpeakerphoneOn(speakerphone);
    notifyListeners();
  }

  // ---- state -----------------------------------------------------------

  void _recompute() {
    if (_room == null && state != AgentUiState.connecting) return;
    AgentUiState s;
    switch (_agentAttrState) {
      case 'speaking':
        s = AgentUiState.speaking;
      case 'thinking':
        s = AgentUiState.thinking;
      case 'listening':
        s = AgentUiState.listening;
      case 'initializing':
        s = AgentUiState.connecting;
      default: // no attribute → fall back to who is making noise
        s = _agentSpeaking ? AgentUiState.speaking : AgentUiState.listening;
    }
    // Barge-in: the caller speaks while the agent still counts as speaking.
    if (s == AgentUiState.speaking && _userSpeaking) s = AgentUiState.interrupting;
    _set(s);
  }

  void _set(AgentUiState next) {
    if (state == next) return;
    state = next;
    notifyListeners();
  }

  void _fail(String message) {
    error = message;
    _set(AgentUiState.error);
  }

  void _cleanup() {
    _listener?.dispose();
    _listener = null;
    _room = null;
    _agentAttrState = null;
    _agentSpeaking = false;
    _userSpeaking = false;
  }

  @override
  void dispose() {
    _room?.disconnect();
    _cleanup();
    super.dispose();
  }
}
