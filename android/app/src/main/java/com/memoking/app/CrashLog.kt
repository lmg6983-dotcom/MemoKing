package com.memoking.app

import android.app.Application
import android.content.Context
import android.os.Build
import java.io.File

/**
 * 오류 기록 — 휴대폰에서만 나는 오류(위젯 · 백그라운드 일)는 PC 에서 볼 수 없으므로,
 * 앱이 멈추거나 위젯에서 오류가 나면 그 내용을 앱 안에 적어 두고, 다음에 메모킹을 열 때 보여 준다 (복사해서 보낼 수 있게).
 */
object CrashLog {
    private const val FILE = "last-error.txt"
    private const val MAX = 16_000

    private fun file(ctx: Context) = File(ctx.applicationContext.filesDir, FILE)

    private fun header(ctx: Context): String {
        val version = try {
            ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName
        } catch (e: Exception) {
            "?"
        }
        return "메모킹 $version · 안드로이드 ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) · ${Build.MANUFACTURER} ${Build.MODEL}\n" +
            java.time.OffsetDateTime.now().withNano(0).toString()
    }

    /** 앱이 멈추는 오류: 적어 두고 원래 처리(앱 종료)는 그대로 */
    fun install(app: Application) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            record(app, "앱이 멈춤 (${thread.name})", e)
            previous?.uncaughtException(thread, e)
        }
    }

    /** 잡은 오류도 적어 둔다 (가장 최근 것 하나 — 앞의 것은 이어 붙여 넘치면 자름) */
    fun record(ctx: Context, where: String, e: Throwable) {
        try {
            val text = "${header(ctx)} · $where\n${e.stackTraceToString()}"
            val f = file(ctx)
            val old = if (f.isFile) f.readText() else ""
            f.writeText((text + if (old.isNotEmpty()) "\n\n--- 이전 ---\n$old" else "").take(MAX))
        } catch (_: Throwable) {
            // 기록하다 또 오류가 나도 원래 일은 막지 않는다
        }
    }

    /** 적어 둔 오류를 꺼낸다 (꺼내면 지움) — 없으면 null */
    fun take(ctx: Context): String? {
        val f = file(ctx)
        if (!f.isFile) return null
        val text = f.readText()
        f.delete()
        return text.ifBlank { null }
    }

    /** 위젯 일 같은 곳을 감싸 앱이 멈추지 않게 (오류는 적어 둠) */
    inline fun <T> guard(ctx: Context, where: String, fallback: T, block: () -> T): T = try {
        block()
    } catch (e: Throwable) {
        android.util.Log.w("MemoKing", where, e)
        record(ctx, where, e)
        fallback
    }
}

/** 앱 프로세스가 뜰 때(화면 · 위젯 · 알림 무엇으로든) 오류 기록을 켠다 */
class MemoKingApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CrashLog.install(this)
        // 0.45~0.46 의 로컬 AI 모델 · 검색 벡터(몇 GB) — AI 는 PC 에서만 쓰게 되어 지운다
        File(filesDir, "ai").takeIf { it.exists() }?.let { Thread { it.deleteRecursively() }.start() }
    }
}
