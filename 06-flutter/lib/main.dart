// lib/main.dart — minimal UI on top of SilkCallController.

import 'package:flutter/material.dart';

import 'silk_call_controller.dart';

void main() => runApp(const SilkVoiceApp());

class SilkVoiceApp extends StatelessWidget {
  const SilkVoiceApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Silk voice agent',
        theme: ThemeData(colorSchemeSeed: const Color(0xFFC2410C), useMaterial3: true),
        home: const CallPage(),
      );
}

class CallPage extends StatefulWidget {
  const CallPage({super.key});

  @override
  State<CallPage> createState() => _CallPageState();
}

class _CallPageState extends State<CallPage> {
  final controller = SilkCallController();

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  static const _colors = {
    AgentUiState.idle: Color(0xFFA8A29E),
    AgentUiState.connecting: Color(0xFFA8A29E),
    AgentUiState.listening: Color(0xFFA8A29E),
    AgentUiState.thinking: Color(0xFFF59E0B),
    AgentUiState.speaking: Color(0xFFDC2626), // red: agent talking
    AgentUiState.interrupting: Color(0xFF16A34A), // green: you cut in
    AgentUiState.error: Color(0xFF7F1D1D),
  };

  static const _labels = {
    AgentUiState.idle: 'Idle',
    AgentUiState.connecting: 'Connecting…',
    AgentUiState.listening: 'Listening',
    AgentUiState.thinking: 'Thinking',
    AgentUiState.speaking: 'Agent speaking',
    AgentUiState.interrupting: 'You interrupted — go ahead',
    AgentUiState.error: 'Error',
  };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Silk voice agent')),
      body: ListenableBuilder(
        listenable: controller,
        builder: (context, _) {
          final s = controller.state;
          final color = _colors[s]!;
          final pulsing = s == AgentUiState.speaking || s == AgentUiState.interrupting;
          return Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                // The "visualizer": a circle whose colour follows the state and
                // that swells while someone is talking.
                AnimatedContainer(
                  duration: const Duration(milliseconds: 150),
                  width: pulsing ? 150 : 120,
                  height: pulsing ? 150 : 120,
                  decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                ),
                const SizedBox(height: 24),
                Chip(
                  avatar: CircleAvatar(backgroundColor: color, radius: 6),
                  label: Text(_labels[s]!),
                ),
                if (controller.callId != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text('call ${controller.callId}', style: Theme.of(context).textTheme.bodySmall),
                  ),
                if (controller.error != null)
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Text(controller.error!, style: const TextStyle(color: Color(0xFF7F1D1D))),
                  ),
                const SizedBox(height: 32),
                if (!controller.inCall)
                  FilledButton(
                    onPressed: s == AgentUiState.connecting ? null : controller.start,
                    child: Text(s == AgentUiState.connecting ? 'Starting…' : 'Start call'),
                  )
                else
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      OutlinedButton(onPressed: controller.hangUp, child: const Text('Hang up')),
                      const SizedBox(width: 12),
                      IconButton.outlined(
                        tooltip: controller.speakerphone ? 'Speaker on' : 'Earpiece',
                        onPressed: controller.toggleSpeakerphone,
                        icon: Icon(controller.speakerphone ? Icons.volume_up : Icons.phone_in_talk),
                      ),
                    ],
                  ),
                const SizedBox(height: 16),
                const Text('Talk over the agent to see the circle turn green.'),
              ],
            ),
          );
        },
      ),
    );
  }
}
