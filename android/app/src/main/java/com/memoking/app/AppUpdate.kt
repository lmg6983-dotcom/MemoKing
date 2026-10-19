package com.memoking.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * 앱 안 업데이트 — PC 의 자동 업데이트에 해당. 공개 배포 저장소(memoking-releases)의 android-latest.json 을 보고,
 * 새 버전이 있으면 APK 를 받아 안드로이드 설치 화면으로 넘긴다 (사용자가 "업데이트" 를 한 번 누른다 — 무음 설치는 스토어 앱만 가능).
 * 설치 화면은 브라우저로 받은 APK 를 열 때와 같은 안드로이드 기본 설치기(ACTION_INSTALL_PACKAGE) — 설치 중 · 완료(열기)까지 그 화면이 보여 준다.
 *   (예전의 설치 세션(PackageInstaller) 방식은 일부 휴대폰에서 "업데이트" 를 눌러도 아무 일도 일어나지 않았다)
 *
 * 정보 파일(CI 가 android.yml 에서 만든다): { versionCode, versionName, apk(주소), size, sha256, notes }
 * 안전: 받는 주소는 우리 배포 저장소(APK_PREFIX)만, 받은 파일은 크기 · SHA-256 이 같아야 설치로 넘긴다
 *       (서명이 다른 APK 는 안드로이드가 설치를 거부한다 — 같은 서명이라 업데이트로 덮어 설치되고 메모는 그대로).
 */
object AppUpdate {
    private const val REPO = "lmg6983-dotcom/memoking-releases"
    const val INFO_URL = "https://github.com/$REPO/releases/download/android/android-latest.json"
    const val APK_PREFIX = "https://github.com/$REPO/releases/download/"
    const val APK_MIME = "application/vnd.android.package-archive"

    /** 새 버전인가 (versionCode 가 더 크면) */
    fun isNewer(currentCode: Int, latestCode: Int): Boolean = latestCode > currentCode

    /** 받을 수 있는 주소인가 — 우리 배포 저장소의 릴리스 파일만 */
    fun trustedApkUrl(url: String): Boolean = url.startsWith(APK_PREFIX) && url.endsWith(".apk") && !url.contains("..")

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return hex(md.digest())
    }

    private fun connect(url: String, timeout: Int): HttpURLConnection {
        var current = URL(url)
        var hops = 0
        while (true) {
            if (current.protocol != "https") throw IOException("안전한 주소(https)가 아니에요")
            val conn = current.openConnection() as HttpURLConnection
            conn.instanceFollowRedirects = false
            conn.connectTimeout = timeout
            conn.readTimeout = timeout
            conn.setRequestProperty("User-Agent", "MemoKing-Android/${BuildConfig.VERSION_NAME}")
            val code = conn.responseCode
            if (code in 300..399 && hops < 6) {
                val location = conn.getHeaderField("Location") ?: return conn
                conn.disconnect()
                current = URL(current, location)
                hops++
                continue
            }
            return conn
        }
    }

    /** 최신 정보를 받아 지금 버전과 견준다 → { available, current, currentCode, version, versionCode, notes, size, sha256, apk } */
    fun check(): JSONObject {
        val conn = connect(INFO_URL, 15_000)
        try {
            if (conn.responseCode != 200) throw IOException("업데이트 정보를 받지 못했어요 (${conn.responseCode}). 인터넷을 확인하고 다시 눌러 주세요")
            val text = conn.inputStream.use { it.readBytes() }.toString(Charsets.UTF_8)
            if (text.length > 200_000) throw IOException("업데이트 정보가 너무 커요")
            val info = JSONObject(text)
            val code = info.getInt("versionCode")
            val apk = info.getString("apk")
            val out = JSONObject()
                .put("current", BuildConfig.VERSION_NAME)
                .put("currentCode", BuildConfig.VERSION_CODE)
                .put("version", info.optString("versionName"))
                .put("versionCode", code)
                .put("notes", info.optString("notes"))
                .put("size", info.optLong("size"))
                .put("sha256", info.optString("sha256").lowercase())
                .put("apk", apk)
                .put("available", isNewer(BuildConfig.VERSION_CODE, code) && trustedApkUrl(apk))
            return out
        } finally {
            conn.disconnect()
        }
    }

    /** 받은 APK 를 두는 곳 (VaultFileProvider 가 설치기에 ~update/<이름> 으로 내어 준다) */
    const val DIR = "updates"

    private fun dir(ctx: Context): File = File(ctx.cacheDir, DIR).also { it.mkdirs() }

    /** 받아 둔 APK 들 지우기 (설치를 마쳤거나 새로 받기 전) */
    fun cleanup(ctx: Context) {
        dir(ctx).listFiles()?.forEach { it.delete() }
    }

    /** 받아 둔 APK (설치 화면이 아직 안 떴거나, 앱이 다시 시작된 경우) */
    fun downloaded(ctx: Context): File? = dir(ctx).listFiles { f -> f.name.endsWith(".apk") }?.firstOrNull()

    /** APK 받기 — 진행(받은 바이트, 전체)을 알리며. 크기 · SHA-256 이 맞아야 파일을 돌려준다 */
    fun download(ctx: Context, info: JSONObject, progress: (Long, Long) -> Unit): File {
        val apk = info.getString("apk")
        if (!trustedApkUrl(apk)) throw IOException("받을 수 없는 주소예요")
        cleanup(ctx)
        val file = File(dir(ctx), "MemoKing-${info.optString("version", "new")}.apk")
        val conn = connect(apk, 20_000)
        try {
            if (conn.responseCode != 200) throw IOException("새 버전을 받지 못했어요 (${conn.responseCode}). 인터넷을 확인하고 다시 눌러 주세요")
            val total = conn.contentLengthLong.takeIf { it > 0 } ?: info.optLong("size")
            var done = 0L
            var last = 0L
            conn.inputStream.use { input ->
                file.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        val now = System.currentTimeMillis()
                        if (now - last > 150) {
                            last = now
                            progress(done, total)
                        }
                    }
                }
            }
            progress(done, total)
            val size = info.optLong("size")
            val want = info.optString("sha256").lowercase()
            if ((size > 0 && file.length() != size) || (want.isNotEmpty() && sha256(file) != want)) {
                file.delete()
                throw IOException("받은 파일이 온전하지 않아요. 다시 받아 주세요")
            }
            return file
        } catch (e: Throwable) {
            file.delete()
            throw e
        } finally {
            conn.disconnect()
        }
    }

    /** "출처를 알 수 없는 앱 설치" 를 메모킹에 허용했는가 (안드로이드 8+) */
    fun canInstall(ctx: Context): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || ctx.packageManager.canRequestPackageInstalls()

    /** 허용 설정 화면 열기 */
    fun openInstallSettings(ctx: Context) {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(intent)
    }

    /** 받은 APK 를 안드로이드 설치 화면으로 — 결과(취소 · 실패)는 startActivityForResult 로 돌아온다 (성공하면 앱이 새 버전으로 바뀐다) */
    fun installIntent(file: File): Intent {
        @Suppress("DEPRECATION")
        return Intent(Intent.ACTION_INSTALL_PACKAGE)
            .setDataAndType(VaultFileProvider.updateUriFor(file.name), APK_MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .putExtra(Intent.EXTRA_RETURN_RESULT, true)
    }

    /** 설치기가 돌려준 결과 → 화면의 안내 번호 (updates.js 의 INSTALL_FAIL: 3 취소 · 6 공간 · 7 서명 · 1 그 밖) — 성공이면 null */
    fun failStatus(ok: Boolean, canceled: Boolean, installResult: Int): Int? = when {
        ok -> null
        canceled -> 3
        installResult == -7 -> 7 // INSTALL_FAILED_UPDATE_INCOMPATIBLE (서명 다름)
        installResult == -4 -> 6 // INSTALL_FAILED_INSUFFICIENT_STORAGE
        else -> 1
    }
}
