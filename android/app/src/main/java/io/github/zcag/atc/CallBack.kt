package io.github.zcag.atc

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** The system's "call back" from the phone's call log (Android 17's unified call history): registering for it is
 *  what lets the dialer list atc's calls, and every atc call is with the assistant, so it just calls again. The
 *  action is system-protected, so only the platform can start this. */
class CallBack : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent?.action == ACTION) startActivity(Intent(this, CallActivity::class.java).setAction(CallActivity.DIAL))
        finish()
    }

    companion object {
        const val ACTION = "android.telecom.action.CALL_BACK"
    }
}
