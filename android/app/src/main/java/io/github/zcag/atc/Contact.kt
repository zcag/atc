package io.github.zcag.atc

import android.Manifest
import android.content.ContentProviderOperation
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds
import java.io.ByteArrayOutputStream

/** An "Assistant" contact on the phone for the assistant's number, so the call log and recents show a name and
 *  the app's icon instead of a bare number. Added once, only with the contacts permission, and only when no
 *  contact has that number yet (their own name for it wins). */
object Contact {
    val permissions = arrayOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS)

    fun ensure(c: Context, number: String) = runCatching {
        if (permissions.any { c.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }) return@runCatching
        val lookup = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
        c.contentResolver.query(lookup, arrayOf(ContactsContract.PhoneLookup._ID), null, null, null)?.use { if (it.moveToFirst()) return@runCatching }
        val ops = arrayListOf(
            ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null)
                .withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null).build(),
            data(CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE).withValue(CommonDataKinds.StructuredName.DISPLAY_NAME, "Assistant").build(),
            data(CommonDataKinds.Phone.CONTENT_ITEM_TYPE).withValue(CommonDataKinds.Phone.NUMBER, number)
                .withValue(CommonDataKinds.Phone.TYPE, CommonDataKinds.Phone.TYPE_MOBILE).build(),
            data(CommonDataKinds.Photo.CONTENT_ITEM_TYPE).withValue(CommonDataKinds.Photo.PHOTO, icon(c)).build(),
        )
        c.contentResolver.applyBatch(ContactsContract.AUTHORITY, ops)
    }

    private fun data(type: String) = ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI)
        .withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
        .withValue(ContactsContract.Data.MIMETYPE, type)

    private fun icon(c: Context): ByteArray {
        val d = c.packageManager.getApplicationIcon(c.packageName)
        val b = Bitmap.createBitmap(256, 256, Bitmap.Config.ARGB_8888)
        d.setBounds(0, 0, 256, 256)
        d.draw(Canvas(b))
        return ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }
}
