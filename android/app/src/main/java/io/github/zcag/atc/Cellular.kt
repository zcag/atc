package io.github.zcag.atc

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.emptyFlow

/** The phone's own (SIM) calls. A SIM call they take or places during an assistant call puts it on hold through Telecom,
 *  and nothing in Telecom gives it back when the SIM call ends: this says when the SIM line is idle again, so the
 *  assistant call can take itself off hold. Needs READ_PHONE_STATE; without it, the call screen's tap is the only way back. */
object Cellular {
    fun allowed(c: Context) = c.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED

    fun idle(c: Context): Flow<Unit> {
        if (Build.VERSION.SDK_INT < 31 || !allowed(c)) return emptyFlow()
        val tm = c.getSystemService(TelephonyManager::class.java) ?: return emptyFlow()
        return callbackFlow {
            val cb = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                override fun onCallStateChanged(state: Int) {
                    if (state == TelephonyManager.CALL_STATE_IDLE) trySend(Unit)
                }
            }
            tm.registerTelephonyCallback(c.mainExecutor, cb)
            awaitClose { tm.unregisterTelephonyCallback(cb) }
        }
    }
}
