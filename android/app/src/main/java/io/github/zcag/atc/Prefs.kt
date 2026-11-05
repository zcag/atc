package io.github.zcag.atc

import android.content.Context
import kotlin.properties.ReadWriteProperty
import kotlin.reflect.KProperty

class Prefs(c: Context) {
    private val p = c.getSharedPreferences("atc", Context.MODE_PRIVATE)

    var server by string()
    var endpoint by string()
    var registered by string()
    var pushError by string()
    var pin by string()
    var token by string()
    var spentCode by string()
    var checklist by string()
    var hinted by string()
    var lastCheck by string()
    var feed by string()
    var feedAt by string()
    var feedError by string()
    var persona by string()
    var persons by string()
    var callLang by string()
    var callNumber by string()
    var askedContacts by string()
    var askedCallLog by string()
    var askedPhoneState by string()
    var look by string()
    var palettes by string()

    fun pinFor(host: String?) = pin?.split(" ")?.takeIf { it[0] == host }?.get(1)

    private fun string() = object : ReadWriteProperty<Any, String?> {
        override fun getValue(thisRef: Any, property: KProperty<*>) = p.getString(property.name, null)
        override fun setValue(thisRef: Any, property: KProperty<*>, value: String?) =
            p.edit().putString(property.name, value).apply()
    }
}
