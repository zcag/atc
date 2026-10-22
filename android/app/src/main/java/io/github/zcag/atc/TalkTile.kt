package io.github.zcag.atc

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

class TalkTile : TileService() {
    override fun onTileAdded() = onStartListening()

    override fun onStartListening() {
        val t = qsTile ?: return
        val p = Prefs(this)
        val urgent = Feed.parse(p.feed)?.urgent()
        t.label = getString(R.string.tile_label)
        t.subtitle = if (p.server == null) "Set up atc" else urgent
        t.state = if (urgent != null) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        t.updateTile()
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    override fun onClick() {
        val i = Live.assist(this)
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 5, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        else @Suppress("DEPRECATION") startActivityAndCollapse(i)
    }
}
