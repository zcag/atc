package io.github.zcag.atc

import android.app.Activity
import android.os.Bundle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Debug builds only: a call's playback without Telecom or the UI, on a line at the given URL, so a recorded arrival
 *  trace can be replayed into the real Voice and Line (`bench/replay.py` in atc's android dir).
 *  adb shell am start -n io.github.zcag.atc/.Replay --es url http://host:port/app */
class Replay : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val url = intent.getStringExtra("url") ?: return finish()
        val wire = Channel<Calls.Wire>(Channel.UNLIMITED)
        val voice = Voice()
        val line = Line(this, url, voice, wire)
        line.open("call")
        CoroutineScope(Dispatchers.Default).launch {
            for (w in wire) {
                if (w is Calls.Wire.Active) voice.start(line)
                else {
                    voice.stop()
                    delay(1_000)
                    line.close()
                    finish()
                    break
                }
            }
        }
    }
}
