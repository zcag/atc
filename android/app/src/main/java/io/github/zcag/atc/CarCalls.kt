package io.github.zcag.atc

import android.content.Intent
import androidx.car.app.CarAppService
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.model.Action
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Template
import androidx.car.app.validation.HostValidator

/** atc in Android Auto as a calling app: one screen to call the assistant. The call itself is the
 *  Telecom call, so Android Auto shows its own in-call view and its buttons answer and hang up. */
class CarCalls : CarAppService() {
    override fun createHostValidator() =
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
        else HostValidator.Builder(this).addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample).build()

    override fun onCreateSession() = object : Session() {
        override fun onCreateScreen(intent: Intent): Screen = CallScreen(carContext)
    }
}

private class CallScreen(c: CarContext) : Screen(c) {
    override fun onGetTemplate(): Template {
        val ready = Calls.canRecord(carContext)
        val b = MessageTemplate.Builder(
            when {
                !ready -> "Allow atc the microphone on the phone once, then call from here."
                Calls.state.value.live -> "A call is on."
                else -> "Talk to the assistant, hands free."
            },
        ).setTitle("Assistant").setHeaderAction(Action.APP_ICON)
        if (ready && !Calls.state.value.live) b.addAction(
            Action.Builder().setTitle("Call").setFlags(Action.FLAG_PRIMARY).setOnClickListener {
                Calls.dial(carContext)
                invalidate()
            }.build(),
        )
        return b.build()
    }
}
