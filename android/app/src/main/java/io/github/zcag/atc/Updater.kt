package io.github.zcag.atc

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
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

    private fun offer(server: String, r: Release) {
        val k = Ui(a)
        val changes = r.changes(BuildConfig.VERSION_CODE)
        val meta = listOfNotNull(r.size.takeIf { it > 0 }?.let(::megabytes), Uri.parse(server).host?.let { "from $it" }, "you have ${BuildConfig.VERSION_NAME}")
        k.dialog("Update to ${r.versionName}", meta = meta.joinToString(" · "), body = when {
            changes.isEmpty() -> k.text("This version lists no changes.", 14f, k.pal.dim)
            else -> k.column(k.dp(6), k.bullets(changes.take(5)),
                (changes.size - 5).takeIf { it > 0 }?.let { k.text("and $it more", 13f, k.pal.faint) })
        }, acts = listOf(Ui.Act("Later"), Ui.Act("Update", primary = true) { download(server, r) }))
    }

    private fun download(server: String, r: Release) {
        val path = r.localApk ?: return refuse("The server names an update outside itself (${r.apk}).")
        toast("Downloading update…")
        thread {
            val apk = File(a.cacheDir, "update/atc.apk")
            val result = runCatching {
                apk.parentFile!!.mkdirs()
                Net.download(a, server + path, apk)
                if (sha256(apk.readBytes()) != r.sha256) error("The download is damaged (checksum mismatch).")
                problem(apk)
            }
            a.runOnUiThread {
                result.fold({ if (it == null) install(apk) else { apk.delete(); refuse(it) } }, { fallback(it.message) })
            }
        }
    }

    private fun problem(apk: File): String? {
        val pm = a.packageManager
        val got = pm.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNING_CERTIFICATES)
        return apkProblem(a.packageName, signers(pm.getPackageInfo(a.packageName, PackageManager.GET_SIGNING_CERTIFICATES)), got?.packageName, signers(got))
    }

    private fun signers(p: PackageInfo?) = p?.signingInfo?.apkContentsSigners.orEmpty().map { sha256(it.toByteArray()) }.toSet()

    private fun refuse(why: String) {
        Ui(a).message("Update refused", "$why\n\natc did not install it. The server may be misconfigured or compromised: check it before updating.")
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
        Ui(a).message("Update failed", "${reason ?: "Something went wrong."}\n\nYou can download the new version from:\n$link",
            Ui.Act("Copy link") { a.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("atc", link)) },
            Ui.Act("Later"),
            Ui.Act("Open in browser", primary = true) { a.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))) })
    }

    private fun toast(text: String) = Toast.makeText(a, text, Toast.LENGTH_SHORT).show()
}
