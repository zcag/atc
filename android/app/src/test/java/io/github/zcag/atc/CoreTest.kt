package io.github.zcag.atc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CoreTest {
    private fun pem(name: String) = Pin.parseAll(javaClass.classLoader!!.getResource(name).readBytes())
    private val issued = pem("chain.pem")[0].notBefore

    @Test fun pinnedRootAcceptsItsChain() = assertTrue(Pin.validates(pem("chain.pem"), pem("root.pem")[0], issued))
    @Test fun pinnedRootRefusesOtherChains() = assertFalse(Pin.validates(pem("chain.pem"), pem("other.pem")[0], issued))
    @Test fun pinnedRootRefusesExpiredLeaf() = assertFalse(Pin.validates(pem("chain.pem"), pem("root.pem")[0], java.util.Date(issued.time + 400L * 86400_000)))
    @Test fun selfSignedLeafCanBeItsOwnAnchor() = assertTrue(Pin.validates(pem("other.pem"), pem("other.pem")[0]))

    @Test fun fingerprint() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sha256("abc".toByteArray()))
        assertEquals("BA:78:16", pretty("ba7816"))
    }

    @Test fun serverUrls() {
        assertEquals("https://atc.example", serverUrl(" https://atc.example/ "))
        assertEquals("http://box:7272/atc", serverUrl("http://box:7272/atc"))
        assertNull(serverUrl("atc.example"))
        assertNull(serverUrl("ftp://atc.example"))
        assertNull(serverUrl("https://"))
    }

    @Test fun release() {
        val r = Release.parse("""{"versionCode":42,"versionName":"0.42","apk":"/app/atc.apk","sha256":"ABCD"}""")
        assertEquals(42, r.versionCode)
        assertEquals("0.42", r.versionName)
        assertEquals("abcd", r.sha256)
        assertTrue(r.newerThan(41))
        assertFalse(r.newerThan(42))
        assertFalse(r.newerThan(43))
    }

    @Test fun note() {
        val n = Note.parse("""{"title":"api","body":"done","tag":"s1","url":"/#/s/s1"}""".toByteArray())!!
        assertEquals("api", n.title)
        assertEquals("done", n.body)
        assertEquals("/#/s/s1", n.url)
        assertEquals(n.id, Note.parse("""{"tag":"s1"}""".toByteArray())!!.id)
    }

    @Test fun noteCarriesReplies() {
        val n = Note.parse("""{"tag":"s1","session":"ab12cd34","replies":["ok go"," ","status?"]}""".toByteArray())!!
        assertEquals("ab12cd34", n.session)
        assertEquals(listOf("ok go", "status?"), n.replies)
        val bad = Note.parse("""{"tag":"s1","session":"../usage","replies":["ok go"]}""".toByteArray())!!
        assertEquals("", bad.session)
        assertEquals(emptyList<String>(), bad.replies)
    }

    @Test fun noteKeepsLinksOnTheServer() {
        assertEquals("/", Note.parse("""{"tag":"s","url":"https://evil.example"}""".toByteArray())!!.url)
        assertEquals("/", Note.parse("""{"tag":"s","url":"//evil.example"}""".toByteArray())!!.url)
        assertNull(Note.parse("not json".toByteArray()))
    }

    @Test fun splitsSentences() =
        assertEquals(listOf("Done.", "Tests pass!", "Next?", "Line"), sentences("Done. Tests pass!  Next?\nLine"))
}
