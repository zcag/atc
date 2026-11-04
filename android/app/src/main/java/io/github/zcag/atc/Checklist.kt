package io.github.zcag.atc

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.verify.domain.DomainVerificationManager
import android.content.pm.verify.domain.DomainVerificationUserState
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.unifiedpush.android.connector.UnifiedPush

/** What the phone has to allow for the app to do its job, each with its state and the way to its system screen. */
class ChecklistActivity : Activity() {
    private enum class State(val word: String) { DONE("Done"), TODO("Not set"), NOT_NEEDED("Not needed") }

    private class Item(val title: String, val why: String, val state: State, val button: String, val go: () -> Unit)

    private lateinit var list: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val pal = Look.palette(this)
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(pal.board))
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !pal.dark
            isAppearanceLightNavigationBars = !pal.dark
        }
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val pad = dp(20)
        val scroll = ScrollView(this).apply { clipToPadding = false; addView(list) }
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(b.left + pad, b.top + pad, b.right + pad, b.bottom + pad)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(scroll)
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun render() {
        val pal = Look.palette(this)
        list.removeAllViews()
        list.addView(TextView(this).apply { text = "Set up this phone"; textSize = 22f; setTextColor(pal.ink) })
        list.addView(TextView(this).apply {
            text = "Each one is optional. Come back any time from Settings › Devices or the back-twice menu."
            setTextColor(pal.dim)
            setPadding(0, dp(4), 0, dp(12))
        })
        items().forEach { item ->
            list.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, dp(14), 0, dp(14))
                addView(LinearLayout(context).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    addView(TextView(context).apply { text = item.title; textSize = 16f; setTextColor(pal.ink) },
                        LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
                    addView(TextView(context).apply {
                        text = item.state.word
                        setTextColor(if (item.state == State.TODO) pal.needs else pal.dim)
                    })
                })
                addView(TextView(context).apply { text = item.why; setTextColor(pal.dim); setPadding(0, dp(2), 0, dp(6)) })
                if (item.state == State.TODO) addView(Button(context).apply { text = item.button; setOnClickListener { item.go() } })
            })
        }
        list.addView(Button(this).apply { text = "Done"; setOnClickListener { finish() } })
    }

    private fun items() = listOf(
        Item("Digital assistant", "Holding the side key opens atc, even on the lock screen.", assistant(), "Open default apps") {
            open(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
        },
        Item("Battery", "Lets notifications and calls reach atc while the phone sleeps.", battery(), "Allow in the background") {
            open(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        },
        Item("Links", links().second, links().first, "Open link settings") {
            if (Build.VERSION.SDK_INT >= 31) open(Intent(Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS, Uri.parse("package:$packageName")))
            else details()
        },
        Item("Microphone", "Calls to the assistant.", granted(Manifest.permission.RECORD_AUDIO), "Allow") {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
        },
        Item("Notifications", "Tells you when a session needs you or finishes.", notifications(), "Allow") {
            if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
            else open(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        },
        distributor(),
    )

    private fun assistant() =
        if (getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_ASSISTANT)) State.DONE else State.TODO

    private fun battery() =
        if (getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)) State.DONE else State.TODO

    private fun links(): Pair<State, String> {
        val host = BuildConfig.APP_LINK_HOST
        if (host.isEmpty()) return State.NOT_NEEDED to "This build opens atc:// links without any setting."
        val why = "Opens https://$host links in the app."
        if (Build.VERSION.SDK_INT < 31) return State.TODO to why
        val st = getSystemService(DomainVerificationManager::class.java).getDomainVerificationUserState(packageName)?.hostToStateMap?.get(host)
        return (if (st != null && st != DomainVerificationUserState.DOMAIN_STATE_NONE) State.DONE else State.TODO) to why
    }

    private fun granted(permission: String) =
        if (checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) State.DONE else State.TODO

    private fun notifications() =
        if (getSystemService(NotificationManager::class.java).areNotificationsEnabled()) State.DONE else State.TODO

    private fun distributor(): Item {
        val why = "UnifiedPush needs a distributor such as the ntfy app to deliver atc's notifications."
        if (Push.status(this) == "ok") return Item("Push distributor", why, State.DONE, "") {}
        if (UnifiedPush.getDistributors(this).isEmpty()) return Item("Push distributor", why, State.TODO, "Find a distributor") {
            open(Intent(Intent.ACTION_VIEW, Uri.parse("https://unifiedpush.org/users/distributors/")))
        }
        return Item("Push distributor", why, State.TODO, "Connect") { Push.start(this); render() }
    }

    private fun open(i: Intent) {
        if (runCatching { startActivity(i) }.isFailure) details()
    }

    private fun details() = startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        val denied = permissions.indices.firstOrNull { grantResults[it] != PackageManager.PERMISSION_GRANTED }
        if (denied != null && !shouldShowRequestPermissionRationale(permissions[denied])) details()
        render()
    }

    companion object {
        private const val REQ_MIC = 1
        private const val REQ_NOTIFY = 2
    }
}
