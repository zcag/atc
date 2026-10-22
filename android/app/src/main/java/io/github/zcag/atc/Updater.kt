package io.github.zcag.atc

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import kotlin.concurrent.thread

class Updater(private val a: MainActivity) {
    private val prefs = Prefs(a)
    private var awaitingPermission: File? = null

    fun maybeCheck() {
        if (System.currentTimeMillis() - (prefs.lastCheck?.toLongOrNull() ?: 0) > 6 * 3600_000) check(manual = false)
    }

    fun check(manual: Boolean) {
        val server = prefs.server ?: return
        prefs.lastCheck = System.currentTimeMillis().toString()
        thread {
            val release = runCatching { Release.parse(Net.get(a, "$server/app/version.json")) }
            a.runOnUiThread {
                release.fold(
                    { if (it.newerThan(BuildConfig.VERSION_CODE)) offer(server, it) else if (manual) toast("atc is up to date") },
                    { if (manual) toast("Update check failed: ${it.message}") },
                )
            }
        }
    }

    fun resume() {
        val apk = awaitingPermission ?: return
        awaitingPermission = null
        if (a.packageManager.canRequestPackageInstalls()) install(apk) else fallback("Installing apps from atc is not allowed.")
    }

    private fun offer(server: String, r: Release) = AlertDialog.Builder(a)
        .setTitle("Update available (${r.versionName})")
        .setPositiveButton("Update") { _, _ -> download(server, r) }
        .setNegativeButton("Later", null)
        .show()

    private fun download(server: String, r: Release) {
        toast("Downloading update")
        thread {
            val apk = File(a.cacheDir, "update/atc.apk")
            val result = runCatching {
                apk.parentFile!!.mkdirs()
                Net.download(a, if (r.apk.startsWith("http")) r.apk else server + r.apk, apk)
                if (sha256(apk.readBytes()) != r.sha256) error("The download is damaged (checksum mismatch).")
            }
            a.runOnUiThread { result.fold({ install(apk) }, { fallback(it.message) }) }
        }
    }

    private fun install(apk: File) {
        if (!a.packageManager.canRequestPackageInstalls()) {
            awaitingPermission = apk
            a.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${a.packageName}")))
            return
        }
        runCatching {
            a.startActivity(Intent(Intent.ACTION_VIEW)
                .setDataAndType(FileProvider.getUriForFile(a, "${a.packageName}.files", apk), "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { fallback(it.message) }
    }

    private fun fallback(reason: String?) {
        val link = "${prefs.server}/app/atc.apk"
        AlertDialog.Builder(a)
            .setTitle("Update failed")
            .setMessage("${reason ?: "Something went wrong."}\n\nYou can download the new version from:\n$link")
            .setPositiveButton("Open in browser") { _, _ -> a.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))) }
            .setNeutralButton("Copy link") { _, _ ->
                a.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("atc", link))
            }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun toast(text: String) = Toast.makeText(a, text, Toast.LENGTH_SHORT).show()
}
