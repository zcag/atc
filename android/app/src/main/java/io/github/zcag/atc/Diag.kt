package io.github.zcag.atc

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.CallLog
import android.provider.ContactsContract
import android.telecom.PhoneAccount
import android.telecom.TelecomManager
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/** What the phone did with a call, sent to atc after each one (/api/call/diag): its Android and One UI version,
 *  whether Telecom has atc's account with logging on, the contacts permission and the Assistant contact, and, with
 *  the call log permission, atc's own rows in the call log, including the VoIP rows dialers hide. */
object Diag {
    fun send(c: Context) = thread {
        val report = runCatching { report(c) }.getOrElse { JSONObject().put("error", it.toString()) }
        val server = Prefs(c).server ?: return@thread
        runCatching { Net.post(c, "$server/api/call/diag", report) }
    }

    private fun granted(c: Context, p: String) = c.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun prop(name: String) = runCatching {
        Class.forName("android.os.SystemProperties").getMethod("get", String::class.java).invoke(null, name) as String
    }.getOrDefault("")

    private fun report(c: Context): JSONObject {
        val o = JSONObject()
            .put("app", BuildConfig.VERSION_NAME)
            .put("sdk", Build.VERSION.SDK_INT).put("release", Build.VERSION.RELEASE)
            .put("sdkFull", runCatching { Build.VERSION::class.java.getField("SDK_INT_FULL").get(null).toString() }.getOrDefault(""))
            .put("model", Build.MODEL).put("oneui", prop("ro.build.version.oneui"))
            .put("contacts", granted(c, Manifest.permission.READ_CONTACTS) && granted(c, Manifest.permission.WRITE_CONTACTS))
            .put("callLog", granted(c, Manifest.permission.READ_CALL_LOG))
        val number = Prefs(c).callNumber.orEmpty()
        o.put("number", number)
        if (Build.VERSION.SDK_INT >= 34) {
            val tm = c.getSystemService(TelecomManager::class.java)
            val account = tm.getPhoneAccount(Telecom.handle(c))
            o.put("account", account?.let {
                JSONObject().put("enabled", it.isEnabled).put("capabilities", it.capabilities)
                    .put("log", it.extras?.getBoolean(PhoneAccount.EXTRA_LOG_SELF_MANAGED_CALLS) ?: false)
            } ?: JSONObject.NULL)
        }
        if (number.isNotEmpty() && granted(c, Manifest.permission.READ_CONTACTS)) {
            val lookup = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
            o.put("contact", c.contentResolver.query(lookup, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)
                ?.use { if (it.moveToFirst()) it.getString(0) else null } ?: JSONObject.NULL)
        }
        if (granted(c, Manifest.permission.READ_CALL_LOG)) {
            o.put("plain", rows(c, CallLog.Calls.CONTENT_URI))
            o.put("withVoip", rows(c, CallLog.Calls.CONTENT_URI.buildUpon().appendQueryParameter("include_voip_calls", "true").build()))
        }
        return o
    }

    /** atc's rows (by its calling account) in the newest 200 of the log, as the given query returns them. */
    private fun rows(c: Context, uri: Uri): JSONObject = runCatching {
        val mine = JSONArray()
        var seen = 0
        c.contentResolver.query(uri, null, null, null, "${CallLog.Calls.DATE} DESC")?.use { cur ->
            val comp = cur.getColumnIndex(CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME)
            while (cur.moveToNext() && seen < 200) {
                seen++
                if (comp < 0 || cur.getString(comp)?.contains(c.packageName) != true) continue
                if (mine.length() >= 3) continue
                val row = JSONObject()
                for (i in 0 until cur.columnCount) if (cur.getType(i) != android.database.Cursor.FIELD_TYPE_BLOB) row.put(cur.getColumnName(i), cur.getString(i))
                mine.put(row)
            }
        }
        JSONObject().put("scanned", seen).put("atc", mine)
    }.getOrElse { JSONObject().put("error", it.toString()) }
}
