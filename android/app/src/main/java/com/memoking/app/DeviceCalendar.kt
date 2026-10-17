package com.memoking.app

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import org.json.JSONArray
import org.json.JSONObject

/**
 * 휴대폰 캘린더 — 삼성 캘린더 · Google 캘린더 등 이 휴대폰의 캘린더 앱이 함께 쓰는 저장소(CalendarContract).
 *   읽기: 일정 탭 달력에 휴대폰 일정도 함께 (READ_CALENDAR 권한, 사용자가 켰을 때만)
 *   넣기: 메모킹 일정을 캘린더 앱의 "새 일정" 화면으로 (권한 없이 — 사용자가 그 앱에서 저장)
 */
object DeviceCalendar {
    private const val MAX = 2000

    fun granted(ctx: Context) = ctx.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED

    /** [from, to) 밀리초 사이의 일정 회차 (반복 일정은 회차마다) */
    fun events(ctx: Context, from: Long, to: Long): JSONObject {
        val out = JSONObject().put("granted", granted(ctx))
        if (!granted(ctx)) return out.put("events", JSONArray())
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, from)
            ContentUris.appendId(it, to)
        }.build()
        val projection = arrayOf(
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
            CalendarContract.Instances.DISPLAY_COLOR,
            CalendarContract.Instances.DESCRIPTION,
        )
        val list = JSONArray()
        ctx.contentResolver.query(uri, projection, "${CalendarContract.Instances.VISIBLE} = 1", null, "${CalendarContract.Instances.BEGIN} ASC")?.use { c ->
            while (c.moveToNext() && list.length() < MAX) {
                list.put(
                    JSONObject()
                        .put("id", c.getLong(0))
                        .put("title", c.getString(1) ?: "")
                        .put("start", c.getLong(2))
                        .put("end", c.getLong(3))
                        .put("allDay", c.getInt(4) == 1)
                        .put("location", c.getString(5) ?: "")
                        .put("calendar", c.getString(6) ?: "")
                        .put("color", String.format("#%06X", 0xFFFFFF and c.getInt(7)))
                        .put("description", (c.getString(8) ?: "").take(4000)),
                )
            }
        }
        return out.put("events", list)
    }
}
