// AudioRouting.kt — OS-level audio routing on Android.
//
// livekit-android ships an AudioSwitch-based handler that tracks the devices
// the OS can route to (Bluetooth headset, wired headset, earpiece,
// speakerphone) and switches between them. We only expose it to the UI.
package ai.rumik.silkvoice

import io.livekit.android.audio.AudioSwitchHandler
import io.livekit.android.room.Room
import com.twilio.audioswitch.AudioDevice

class AudioRouting(private val room: Room) {
    private val handler: AudioSwitchHandler? get() = room.audioHandler as? AudioSwitchHandler

    /** Everything the OS can currently route to, e.g. [BluetoothHeadset, Speakerphone, Earpiece]. */
    val availableDevices: List<AudioDevice> get() = handler?.availableAudioDevices.orEmpty()

    val selectedDevice: AudioDevice? get() = handler?.selectedAudioDevice

    /** Route to a specific device. Pass null to let AudioSwitch pick by priority (Bluetooth > wired > earpiece > speaker). */
    fun select(device: AudioDevice?) = handler?.selectDevice(device)

    fun setSpeakerphone(on: Boolean) {
        val target = if (on) availableDevices.firstOrNull { it is AudioDevice.Speakerphone }
                     else availableDevices.firstOrNull { it is AudioDevice.Earpiece }
        select(target)
    }

    companion object {
        fun label(device: AudioDevice?): String = when (device) {
            is AudioDevice.BluetoothHeadset -> "Bluetooth: ${device.name}"
            is AudioDevice.WiredHeadset -> "Wired headset"
            is AudioDevice.Earpiece -> "Earpiece"
            is AudioDevice.Speakerphone -> "Speaker"
            null -> "—"
        }
    }
}
