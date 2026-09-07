// CallViewModel.kt — bridges LiveKit's RoomEvent flow into Compose state.
//
// UI state machine:
//   IDLE → CONNECTING → LISTENING ⇄ THINKING ⇄ SPEAKING → (INTERRUPTING) → … → IDLE
//
// SPEAKING is red; INTERRUPTING (the caller talks over the agent) is green.
// State comes from the agent's `lk.agent.state` attribute when it publishes
// one, and from ActiveSpeakersChanged otherwise.
package ai.rumik.silkvoice

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.twilio.audioswitch.AudioDevice
import io.livekit.android.AudioOptions
import io.livekit.android.AudioType
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.participant.RemoteParticipant
import io.livekit.android.room.track.LocalAudioTrackOptions
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class AgentUiState(val label: String) {
    IDLE("Idle"),
    CONNECTING("Connecting…"),
    LISTENING("Listening"),
    THINKING("Thinking"),
    SPEAKING("Agent speaking"),
    INTERRUPTING("You interrupted — go ahead"),
    ERROR("Error"),
}

data class CallUi(
    val state: AgentUiState = AgentUiState.IDLE,
    val error: String? = null,
    val callId: String? = null,
    val inCall: Boolean = false,
    val outputDevice: String = "—",
    val availableDevices: List<AudioDevice> = emptyList(),
)

private const val AGENT_STATE_ATTR = "lk.agent.state"

class CallViewModel(app: Application) : AndroidViewModel(app) {

    private val _ui = MutableStateFlow(CallUi())
    val ui: StateFlow<CallUi> = _ui

    // One Room for the lifetime of the ViewModel; connect/disconnect per call.
    // AudioType.CallAudioType puts the AudioManager into MODE_IN_COMMUNICATION with
    // USAGE_VOICE_COMMUNICATION: that is what enables the hardware echo canceller
    // so the agent does not hear itself out of the phone speaker.
    private val room: Room = LiveKit.create(
        appContext = app,
        options = RoomOptions(
            adaptiveStream = true,
            dynacast = true,
            audioTrackCaptureDefaults = LocalAudioTrackOptions(
                echoCancellation = true,
                noiseSuppression = true,
                autoGainControl = true,
            ),
        ),
        overrides = LiveKitOverrides(
            audioOptions = AudioOptions(audioOutputType = AudioType.CallAudioType()),
        ),
    )
    val routing = AudioRouting(room)

    private var eventsJob: Job? = null
    private var agentAttrState: String? = null
    private var agentSpeaking = false
    private var userSpeaking = false

    fun start() {
        if (_ui.value.inCall) return
        _ui.update { it.copy(error = null, state = AgentUiState.CONNECTING) }
        viewModelScope.launch {
            try {
                // 1. Credentials from your backend (RECORD_AUDIO was requested by the Activity first —
                //    /v1/webcall bills the moment it returns, so never start a call you cannot join).
                val creds = SilkApi.startCall()

                // 2. Subscribe to room events before connecting so nothing is missed.
                eventsJob = launch { room.events.collect { onRoomEvent(it) } }

                // 3. Join and publish the microphone. The agent greets as soon as it sees us.
                room.connect(creds.host, creds.token)
                room.localParticipant.setMicrophoneEnabled(true)

                // 4. The agent may already be in the room with a state attribute.
                room.remoteParticipants.values.forEach { p ->
                    p.attributes[AGENT_STATE_ATTR]?.let { agentAttrState = it }
                }
                _ui.update { it.copy(inCall = true, callId = creds.callId) }
                refreshRouting()
                recompute()
            } catch (e: Exception) {
                eventsJob?.cancel()
                _ui.update { it.copy(state = AgentUiState.ERROR, error = e.toString(), inCall = false) }
            }
        }
    }

    fun hangUp() {
        viewModelScope.launch { room.disconnect() } // → RoomEvent.Disconnected → IDLE; billing stops
    }

    fun selectDevice(device: AudioDevice) {
        routing.select(device)
        refreshRouting()
    }

    private fun onRoomEvent(event: RoomEvent) {
        when (event) {
            is RoomEvent.ActiveSpeakersChanged -> {
                agentSpeaking = event.speakers.any { it is RemoteParticipant }
                userSpeaking = event.speakers.any { it is LocalParticipant }
                recompute()
            }
            is RoomEvent.ParticipantAttributesChanged -> {
                if (event.participant is RemoteParticipant) {
                    event.changedAttributes[AGENT_STATE_ATTR]?.let { agentAttrState = it; recompute() }
                }
            }
            is RoomEvent.TrackSubscribed -> {
                // Remote audio plays automatically; nothing to attach on Android.
            }
            is RoomEvent.Disconnected -> {
                eventsJob?.cancel()
                agentAttrState = null; agentSpeaking = false; userSpeaking = false
                _ui.update { it.copy(state = AgentUiState.IDLE, inCall = false) }
            }
            else -> Unit
        }
    }

    private fun recompute() {
        var s = when (agentAttrState) {
            "speaking" -> AgentUiState.SPEAKING
            "thinking" -> AgentUiState.THINKING
            "listening" -> AgentUiState.LISTENING
            "initializing" -> AgentUiState.CONNECTING
            else -> if (agentSpeaking) AgentUiState.SPEAKING else AgentUiState.LISTENING // no attribute → who is making noise
        }
        // Barge-in: the caller speaks while the agent still counts as speaking.
        if (s == AgentUiState.SPEAKING && userSpeaking) s = AgentUiState.INTERRUPTING
        _ui.update { it.copy(state = s) }
    }

    private fun refreshRouting() {
        _ui.update {
            it.copy(
                outputDevice = AudioRouting.label(routing.selectedDevice),
                availableDevices = routing.availableDevices,
            )
        }
    }

    override fun onCleared() {
        viewModelScope.launch { room.disconnect() }
        room.release()
        super.onCleared()
    }
}
