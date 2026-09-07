// SilkApi.kt — the only call the app makes to *your* backend.
//
//   POST TOKEN_URL  ->  { token, host, roomName, callId }
//
// The backend (see ../shared/token-server-node) holds the rk_live_ key and
// calls Silk's /v1/webcall. The app never sees the key.
package ai.rumik.silkvoice

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

data class CallCredentials(val token: String, val host: String, val roomName: String, val callId: String)

class SilkApiException(val status: Int, val code: String, message: String) : Exception(message) {
    override fun toString(): String = FRIENDLY[code] ?: "$status $code: $message"

    companion object {
        private val FRIENDLY = mapOf(
            "agent_not_deployed" to "The agent has not been deployed yet — press Deploy in the dashboard.",
            "insufficient_balance" to "The account cannot fund a call right now.",
            "concurrency_limit_exceeded" to "All call slots are busy. Try again in a moment.",
        )
    }
}

object SilkApi {
    /** Emulator: 10.0.2.2 reaches the host machine. Device: LAN IP or an ngrok https URL. */
    var tokenUrl: String = "http://10.0.2.2:8787/api/token"

    private val http = OkHttpClient()

    suspend fun startCall(): CallCredentials = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(tokenUrl)
            .post("{}".toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { res ->
            val body = res.body?.string().orEmpty()
            val json = runCatching { JSONObject(body) }.getOrDefault(JSONObject())
            if (!res.isSuccessful) {
                throw SilkApiException(res.code, json.optString("code", "error"), json.optString("error", body))
            }
            CallCredentials(
                token = json.getString("token"),
                host = json.getString("host"),
                roomName = json.optString("roomName"),
                callId = json.optString("callId"),
            )
        }
    }
}
