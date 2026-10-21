package com.memoking.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.memoking.app.drive.DriveSync
import java.io.File

/** 지금 쓰는 메모 폴더를 기억한다: "internal"(이 휴대폰에만) 또는 사용자가 고른 폴더(SAF 주소) */
object Vaults {
    const val INTERNAL = "internal"
    private const val PREFS = "memoking"
    private const val KEY = "vault"

    private var cached: Pair<String, Storage>? = null

    fun internalRoot(ctx: Context) = File(ctx.filesDir, "메모킹")

    // ---------- 튜토리얼 연습 공간 ----------
    // 튜토리얼 동안 화면(웹)은 앱 안의 빈 폴더를 쓴다. 실제 메모 폴더 · 위젯 · 알림 · Drive 동기화는 그대로 (current)
    const val SANDBOX_SHARE = "sandbox"
    @Volatile
    var sandbox: Storage? = null
        private set

    fun sandboxRoot(ctx: Context) = File(ctx.filesDir, "연습 공간")

    @Synchronized
    fun setSandbox(ctx: Context, on: Boolean) {
        sandboxRoot(ctx).deleteRecursively() // 켤 때는 빈 폴더로, 끌 때는 남기지 않게
        sandbox = if (on) FileStorage(sandboxRoot(ctx), "연습 공간", SANDBOX_SHARE) else null
    }

    /** 화면(웹)이 읽고 쓰는 폴더: 연습 중이면 연습 공간 */
    fun forScreen(ctx: Context): Storage? = sandbox ?: current(ctx)

    fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun spec(ctx: Context): String? = prefs(ctx).getString(KEY, null)

    @Synchronized
    fun current(ctx: Context): Storage? {
        val spec = spec(ctx) ?: return null
        cached?.let { (s, storage) -> if (s == spec) return storage }
        val storage = open(ctx, spec) ?: return null
        cached = spec to storage
        return storage
    }

    private fun open(ctx: Context, spec: String): Storage? {
        if (spec == INTERNAL) return FileStorage(internalRoot(ctx), "이 휴대폰 안 (메모킹 앱)")
        // Google Drive 폴더: 휴대폰 쪽 사본(앱 안)을 메모 폴더로 쓰고, DriveSync 가 Drive 와 맞춘다
        if (spec.startsWith(DriveSync.PREFIX)) return DriveSync.storage(ctx, spec.removePrefix(DriveSync.PREFIX))
        val uri = Uri.parse(spec)
        // 권한을 잃었으면(폴더를 지웠거나 앱 데이터를 옮김) 다시 골라야 한다
        val granted = ctx.contentResolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission && it.isWritePermission }
        return if (granted) SafStorage(ctx, uri) else null
    }

    @Synchronized
    fun use(ctx: Context, spec: String): Storage? {
        val storage = open(ctx, spec) ?: return null
        val old = spec(ctx)
        prefs(ctx).edit().putString(KEY, spec).apply()
        cached = spec to storage
        if (!spec.startsWith(DriveSync.PREFIX)) DriveSync.cancelSchedule(ctx)
        // 예전에 고른 폴더의 권한은 돌려준다 (앱이 붙잡을 수 있는 폴더 수에 한도가 있음)
        if (old != null && old != spec && old != INTERNAL && !old.startsWith(DriveSync.PREFIX)) {
            try {
                ctx.contentResolver.releasePersistableUriPermission(
                    Uri.parse(old), Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                )
            } catch (e: SecurityException) {
                // 이미 없음
            }
        }
        return storage
    }
}
