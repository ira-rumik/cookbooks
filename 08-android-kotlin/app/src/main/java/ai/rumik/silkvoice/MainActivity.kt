// MainActivity.kt — requests RECORD_AUDIO at runtime, then hosts CallScreen.
package ai.rumik.silkvoice

import ai.rumik.silkvoice.ui.CallScreen
import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {

    private val vm: CallViewModel by viewModels()

    // Ask for the microphone BEFORE the first call: /v1/webcall bills the moment it
    // returns, so we never start a call the user cannot join.
    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val needed = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (android.os.Build.VERSION.SDK_INT >= 31) add(Manifest.permission.BLUETOOTH_CONNECT) // headset routing
        }.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isNotEmpty()) micPermission.launch(needed.toTypedArray())

        setContent {
            MaterialTheme {
                Surface { CallScreen(vm) }
            }
        }
    }
}
