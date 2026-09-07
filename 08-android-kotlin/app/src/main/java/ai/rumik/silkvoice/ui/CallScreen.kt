// ui/CallScreen.kt — Compose UI on top of CallViewModel.
package ai.rumik.silkvoice.ui

import ai.rumik.silkvoice.AgentUiState
import ai.rumik.silkvoice.AudioRouting
import ai.rumik.silkvoice.CallViewModel
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

private fun colorFor(s: AgentUiState): Color = when (s) {
    AgentUiState.THINKING -> Color(0xFFF59E0B)
    AgentUiState.SPEAKING -> Color(0xFFDC2626)      // red: agent talking
    AgentUiState.INTERRUPTING -> Color(0xFF16A34A)  // green: you cut in
    AgentUiState.ERROR -> Color(0xFF7F1D1D)
    else -> Color(0xFFA8A29E)
}

@Composable
fun CallScreen(vm: CallViewModel) {
    val ui by vm.ui.collectAsStateWithLifecycle()
    val color by animateColorAsState(colorFor(ui.state), label = "state")
    val talking = ui.state == AgentUiState.SPEAKING || ui.state == AgentUiState.INTERRUPTING
    val size by animateDpAsState(if (talking) 150.dp else 120.dp, label = "size")
    var menuOpen by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Silk voice agent", style = MaterialTheme.typography.headlineSmall)
        Text("Jetpack Compose · LiveKit · WebRTC", style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(32.dp))

        // The "visualizer": a circle whose colour follows the state and that swells while someone talks.
        Box(Modifier.size(size).background(color, CircleShape))
        Spacer(Modifier.height(24.dp))

        AssistChip(onClick = {}, label = { Text(ui.state.label) },
            leadingIcon = { Box(Modifier.size(10.dp).background(color, CircleShape)) })

        ui.callId?.let { Text("call $it", style = MaterialTheme.typography.bodySmall) }
        ui.error?.let { Text(it, color = Color(0xFF7F1D1D), modifier = Modifier.padding(16.dp)) }
        Spacer(Modifier.height(32.dp))

        if (!ui.inCall) {
            Button(onClick = vm::start, enabled = ui.state != AgentUiState.CONNECTING) {
                Text(if (ui.state == AgentUiState.CONNECTING) "Starting…" else "Start call")
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = vm::hangUp) { Text("Hang up") }
                Spacer(Modifier.width(12.dp))
                // Route picker: Bluetooth headset / wired / earpiece / speaker
                Box {
                    OutlinedButton(onClick = { menuOpen = true }) { Text(ui.outputDevice) }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        ui.availableDevices.forEach { device ->
                            DropdownMenuItem(
                                text = { Text(AudioRouting.label(device)) },
                                onClick = { vm.selectDevice(device); menuOpen = false },
                            )
                        }
                    }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        Text("Talk over the agent to see the circle turn green.", style = MaterialTheme.typography.bodySmall)
    }
}
