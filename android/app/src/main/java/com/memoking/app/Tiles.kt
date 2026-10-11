package com.memoking.app

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * 빠른 설정 타일 (알림창을 내려 나오는 단추들): "새 메모" · "음성 메모" — 어디서든 한 번에 메모킹으로.
 * 앱 아이콘을 길게 눌러 나오는 바로가기(shortcuts.xml)와 같은 일을 한다.
 */
abstract class MemoTile(private val action: String) : TileService() {
    override fun onStartListening() {
        qsTile?.apply {
            state = Tile.STATE_INACTIVE
            updateTile()
        }
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    override fun onClick() {
        val intent = Intent(this, MainActivity::class.java).setAction(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, action.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}

class NewMemoTile : MemoTile(MainActivity.ACTION_NEW_MEMO)

class VoiceMemoTile : MemoTile(MainActivity.ACTION_NEW_VOICE)
