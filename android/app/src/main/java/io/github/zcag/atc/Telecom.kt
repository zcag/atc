package io.github.zcag.atc

import android.content.ComponentName
import android.content.Context
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Bundle
import android.os.OutcomeReceiver
import android.telecom.CallAttributes
import android.telecom.CallControl
import android.telecom.CallControlCallback
import android.telecom.CallEndpoint
import android.telecom.CallEventCallback
import android.telecom.CallException
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.annotation.RequiresApi
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.Executor
import java.util.function.Consumer
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The call as Android's own Telecom sees it (the transactional API of Android 14): a self-managed account that
 *  asks Telecom to write its calls into the phone's call log, so they show in recents like any call. Remote
 *  surfaces (Bluetooth, car, watch) reach the call through the callbacks, which turn into the session's commands. */
@RequiresApi(34)
class Telecom(private val c: Context, private val inbox: SendChannel<Calls.Cmd>) {
    val endpoint = MutableStateFlow<CallEndpoint?>(null)
    val endpoints = MutableStateFlow<List<CallEndpoint>>(emptyList())
    val muted = MutableStateFlow(false)
    private var control: CallControl? = null
    private val run = Executor { it.run() }

    private val handle get() = PhoneAccountHandle(ComponentName(c, CallService::class.java), "assistant")

    private fun register(tm: TelecomManager) = tm.registerPhoneAccount(
        PhoneAccount.builder(handle, "atc")
            .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED or PhoneAccount.CAPABILITY_SUPPORTS_TRANSACTIONAL_OPERATIONS)
            .setIcon(Icon.createWithResource(c, R.drawable.ic_call))
            .setShortDescription("Calls with the assistant")
            .setSupportedUriSchemes(listOf(PhoneAccount.SCHEME_TEL, PhoneAccount.SCHEME_SIP))
            .setExtras(Bundle().apply { putBoolean(PhoneAccount.EXTRA_LOG_SELF_MANAGED_CALLS, true) })
            .build(),
    )

    suspend fun add(incoming: Boolean, address: Uri) {
        val tm = c.getSystemService(TelecomManager::class.java)
        register(tm)
        val attrs = CallAttributes.Builder(handle,
            if (incoming) CallAttributes.DIRECTION_INCOMING else CallAttributes.DIRECTION_OUTGOING, "Assistant", address)
            .setCallType(CallAttributes.AUDIO_CALL)
            .setCallCapabilities(CallAttributes.SUPPORTS_SET_INACTIVE)
            .build()
        control = suspendCancellableCoroutine { k ->
            tm.addCall(attrs, run, object : OutcomeReceiver<CallControl, CallException> {
                override fun onResult(result: CallControl) = k.resume(result)
                override fun onError(error: CallException) = k.resumeWithException(error)
            }, object : CallControlCallback {
                override fun onSetActive(done: Consumer<Boolean>) = done.accept(inbox.trySend(Calls.Cmd.Unhold).isSuccess)
                override fun onSetInactive(done: Consumer<Boolean>) = done.accept(inbox.trySend(Calls.Cmd.Hold).isSuccess)
                override fun onAnswer(videoState: Int, done: Consumer<Boolean>) = done.accept(inbox.trySend(Calls.Cmd.Answer).isSuccess)
                override fun onDisconnect(cause: DisconnectCause, done: Consumer<Boolean>) = done.accept(inbox.trySend(Calls.Cmd.Hangup).isSuccess)
                override fun onCallStreamingStarted(done: Consumer<Boolean>) = done.accept(false)
            }, object : CallEventCallback {
                override fun onCallEndpointChanged(e: CallEndpoint) { endpoint.value = e }
                override fun onAvailableCallEndpointsChanged(list: List<CallEndpoint>) { endpoints.value = list }
                override fun onMuteStateChanged(on: Boolean) { muted.value = on }
                override fun onCallStreamingFailed(reason: Int) {}
                override fun onEvent(event: String, extras: Bundle) {}
            })
        }
    }

    suspend fun answer() = op { control?.answer(CallAttributes.AUDIO_CALL, run, it) }

    suspend fun setActive() = op { control?.setActive(run, it) }

    suspend fun disconnect(cause: Int) = op { control?.disconnect(DisconnectCause(cause), run, it) }

    suspend fun route(to: CallEndpoint) = op { control?.requestCallEndpointChange(to, run, it) }

    private suspend fun op(f: (OutcomeReceiver<Void, CallException>) -> Unit?): Boolean = suspendCancellableCoroutine { k ->
        f(object : OutcomeReceiver<Void, CallException> {
            override fun onResult(result: Void?) = k.resume(true)
            override fun onError(error: CallException) = k.resume(false)
        }) ?: k.resume(false)
    }
}
