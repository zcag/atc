package io.github.zcag.atc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedTest {
    private val json = """{"type":"sessions","at":"2026-10-23T10:00:00.123456789Z","sessions":[
        {"id":"a1","sid":"s-1","title":"api","state":"needs-you","host":"box","pinned":true,"since":"2026-10-23T09:57:00Z"},
        {"sid":"s-2","title":"","state":"your-turn","host":"box","since":"2026-10-23T12:50:00+03:00"},
        {"id":"c3","sid":"s-3","title":"web","state":"working","host":"lap"},
        {"id":"d4","sid":"s-4","title":"docs","state":"needs-you","host":"box","since":"2026-10-23T09:59:30Z"}]}"""
    private val at = java.time.Instant.parse("2026-10-23T10:00:00.123Z").toEpochMilli()

    @Test fun parses() {
        val f = Feed.parse(json)!!
        assertEquals(at, f.at)
        assertEquals(4, f.sessions.size)
        val (a, b, c) = f.sessions
        assertEquals("a1", a.key)
        assertTrue(a.pinned)
        assertEquals("s-2", b.key)
        assertNull(b.id)
        assertEquals("s-2", b.title)
        assertEquals(0L, c.since)
        assertEquals(java.time.Instant.parse("2026-10-23T09:50:00Z").toEpochMilli(), b.since)
    }

    @Test fun rejectsAlertsAndJunk() {
        assertNull(Feed.parse("""{"title":"api","body":"done","tag":"s1","url":"/#/s/s1"}"""))
        assertNull(Feed.parse("not json"))
        assertNull(Feed.parse(null))
        assertNull(Feed.parse("""{"type":"sessions","sessions":[{"title":"no sid"}]}"""))
    }

    @Test fun counts() {
        val f = Feed.parse(json)!!
        assertEquals(2, f.count(Feed.NEEDS))
        assertEquals("2 need you", f.urgent())
        assertEquals("1 needs you", Feed.parse("""{"type":"sessions","sessions":[{"sid":"x","state":"needs-you"}]}""")!!.urgent())
        assertNull(Feed.parse("""{"type":"sessions","sessions":[]}""")!!.urgent())
        assertEquals(listOf("s-1" to "api", "s-3" to "web", "s-4" to "docs"), f.targets())
    }

    @Test fun asksBaysAndTheAssistant() {
        val f = Feed.parse("""{"type":"sessions","at":"2026-10-23T10:00:00Z","assistant":{"text":"All shipped.","at":"2026-10-23T09:58:00Z"},"sessions":[
            {"sid":"q","title":"dialogs","state":"needs-you","bay":"atc","summary":"Asks about Back",
             "ask":{"sid":"q","id":"claude","key":"k1","text":"Back closes?","options":["Close the dialog","Go back"]}},
            {"sid":"w","title":"tests","state":"working"}]}""")!!
        val (q, w) = f.sessions
        assertEquals("atc", q.bay)
        assertEquals("Asks about Back", q.summary)
        assertEquals(listOf("Close the dialog", "Go back"), q.ask!!.options)
        assertNull(w.ask)
        assertEquals("", w.bay)
        assertEquals("All shipped.", f.said!!.text)
        assertTrue(f.said!!.at > 0)
        assertNull(Feed.parse("""{"type":"sessions","sessions":[]}""")!!.said)
    }

    @Test fun elapsedTimes() {
        assertEquals("now", elapsed(-5_000))
        assertEquals("now", elapsed(59_000))
        assertEquals("1m", elapsed(60_000))
        assertEquals("59m", elapsed(3_599_000))
        assertEquals("1h", elapsed(3_600_000))
        assertEquals("47h", elapsed(47 * 3_600_000L))
        assertEquals("2d", elapsed(48 * 3_600_000L))
    }
}
