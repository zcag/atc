package io.github.zcag.atc

import android.webkit.JavascriptInterface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeTest {
    class Target {
        var got: String? = null
        @JavascriptInterface fun version() = 7
        @JavascriptInterface fun name(): String? = null
        @JavascriptInterface fun set(json: String) { got = json }
        @JavascriptInterface fun boom(): String = error("boom")
        fun hidden() = "hidden"
    }

    private val target = Target()
    private val gate = Gate(target, "key")

    @Test fun returnsSynchronously() {
        assertEquals("[7]", gate.invoke("key", "version", "[]"))
        assertEquals("[null]", gate.invoke("key", "name", "[]"))
    }

    @Test fun passesArguments() {
        gate.invoke("key", "set", """["{\"a\":1}"]""")
        assertEquals("""{"a":1}""", target.got)
    }

    @Test fun nothingWithoutTheSecret() {
        for (wrong in listOf("", "ke", "keyy", "null")) assertNull(gate.invoke(wrong, "version", "[]"))
        gate.invoke("", "set", """["x"]""")
        assertNull(target.got)
    }

    @Test fun onlyAnnotatedMethods() {
        for (name in listOf("hidden", "getClass", "toString", "nope")) assertNull(name, gate.invoke("key", name, "[]"))
    }

    @Test fun badCallsReturnNothing() {
        assertNull(gate.invoke("key", "set", "[]"))
        assertNull(gate.invoke("key", "set", "not json"))
        assertNull(gate.invoke("key", "boom", "[]"))
    }

    @Test fun scriptChecksOriginBeforeItTouchesTheSecret() {
        val s = gate.startScript(setOf("https://atc.example"))
        assertTrue(s.indexOf("self.origin") < s.indexOf("\"key\""))
        assertFalse(s, s.substringAfter("(...args) =>").contains("\"key\""))
    }

    @Test fun origins() {
        assertEquals(setOf("https://atc.example"), bridgeOrigins("https://atc.example"))
        assertEquals(setOf("https://atc.example"), bridgeOrigins("https://ATC.example/"))
        assertEquals(setOf("https://atc.example"), bridgeOrigins("https://atc.example:443/atc"))
        assertEquals(setOf("https://box:7272"), bridgeOrigins("https://box:7272"))
        assertEquals(setOf("http://box:7272", "https://box"), bridgeOrigins("http://box:7272"))
        assertEquals(setOf("http://box", "https://box"), bridgeOrigins("http://box:80"))
        assertTrue(bridgeOrigins("nonsense").isEmpty())
    }
}
