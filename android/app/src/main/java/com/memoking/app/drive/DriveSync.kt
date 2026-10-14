package com.memoking.app.drive

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import com.memoking.app.FileStorage
import com.memoking.app.Storage
import com.memoking.app.Vaults
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Google Drive 동기화 관리. 메모 폴더가 "drive:<폴더 id>" 일 때만 움직인다.
 * 휴대폰 쪽 메모는 앱 안 폴더(files/drive/<폴더 id>)에 두고, 이 폴더와 Drive 폴더를 맞춘다.
 *
 * 언제: 앱을 열 때·화면으로 돌아올 때, 메모를 고친 뒤 몇 초, 화면이 보이는 동안 1분마다,
 *       앱이 꺼져 있을 때는 시스템 작업으로 약 15분마다 (인터넷이 될 때).
 */
object DriveSync {
    const val PREFIX = "drive:"
    /** 메모킹이 Drive 에 만드는 폴더 (PC 와 같은 이름 — desktop/main.js SYNC_FOLDER) */
    const val SYNC_FOLDER = "메모킹 동기화"
    private const val KEY_FOLDER_NAME = "driveFolderName"
    private const val JOB_ID = 4201

    data class Status(
        val state: String, // off | idle | syncing | error
        val lastSync: Long,
        val error: String,
        val changed: Boolean = false,
        val conflicts: List<String> = emptyList(),
    ) {
        fun json(): JSONObject = JSONObject().put("state", state).put("lastSync", lastSync).put("error", error)
            .put("changed", changed).put("conflicts", org.json.JSONArray(conflicts))
    }

    private val worker = Executors.newSingleThreadScheduledExecutor()
    private var pending: ScheduledFuture<*>? = null
    @Volatile var status = Status("off", 0, "")
        private set

    /** 상태가 바뀔 때마다 (화면에 알리기) */
    @Volatile var listener: ((Status) -> Unit)? = null

    fun folderId(ctx: Context): String? = Vaults.spec(ctx)?.takeIf { it.startsWith(PREFIX) }?.removePrefix(PREFIX)
    fun active(ctx: Context) = folderId(ctx) != null
    fun folderName(ctx: Context): String = Vaults.prefs(ctx).getString(KEY_FOLDER_NAME, "") ?: ""

    fun mirrorDir(ctx: Context, folderId: String) = File(File(ctx.filesDir, "drive"), folderId)
    private fun stateFile(ctx: Context, folderId: String) = File(File(ctx.filesDir, "drive"), "$folderId.state.json")

    fun storage(ctx: Context, folderId: String): Storage =
        FileStorage(mirrorDir(ctx, folderId), "Google Drive › ${folderName(ctx).ifEmpty { "메모 폴더" }}")

    private fun publish(next: Status) {
        status = next
        listener?.invoke(next)
    }

    /** 동기화를 부탁한다 (delayMs 안에 또 부탁하면 한 번으로) */
    @Synchronized
    fun request(ctx: Context, delayMs: Long = 0) {
        if (!active(ctx) || !GoogleAuth.connected(ctx)) return
        val app = ctx.applicationContext
        pending?.cancel(false)
        pending = worker.schedule({ runNow(app) }, delayMs, TimeUnit.MILLISECONDS)
    }

    /** 지금 바로 (작업 스레드에서 순서대로) — 끝날 때까지 기다린다 */
    /** full: Drive 폴더를 처음부터 훑는다 ("지금 동기화" 단추 — 다른 앱이 넣은 파일까지) */
    fun syncBlocking(ctx: Context, full: Boolean = false): Status = worker.submit<Status> { runNow(ctx.applicationContext, full) }.get()

    private fun runNow(ctx: Context, full: Boolean = false): Status {
        val folderId = folderId(ctx) ?: return Status("off", 0, "").also(::publish)
        if (!GoogleAuth.connected(ctx)) return Status("error", status.lastSync, "Google Drive에 로그인해 주세요").also(::publish)
        publish(status.copy(state = "syncing", changed = false, conflicts = emptyList()))
        val file = stateFile(ctx, folderId)
        val state = try {
            JSONObject(file.readText())
        } catch (e: Exception) {
            JSONObject()
        }
        val result = try {
            SyncEngine(storage(ctx, folderId), DriveApi(ctx), folderId, state).run(full)
        } catch (e: Exception) {
            android.util.Log.w("MemoKing", "Drive 동기화 실패", e)
            saveState(file, state)
            val message = when (e) {
                is java.net.UnknownHostException, is java.net.ConnectException, is java.net.SocketTimeoutException -> "인터넷에 연결되지 않아 동기화하지 못했어요"
                else -> e.message ?: "동기화하지 못했어요"
            }
            return Status("error", status.lastSync, message).also(::publish)
        }
        saveState(file, state)
        if (result.downloaded > 0) {
            // 다른 기기에서 잠근 메모를 홈 화면 위젯에서 바로 숨김 — 위젯의 파일 일은 한 줄로(체크·내용 보내기와 서로 덮어쓰지 않게),
            // 동기화가 끝났다고 알리기 전에 마친다 (그 뒤 앱이 바로 꺼져도 풀린 글이 위젯에 남지 않게)
            try {
                com.memoking.app.Widgets.io.submit<Unit> { com.memoking.app.Widgets.hideLocked(ctx) }.get(20, TimeUnit.SECONDS)
            } catch (e: Exception) {
                android.util.Log.w("MemoKing", "위젯 확인 실패", e)
            }
        }
        GoogleAuth.ensureEmail(ctx)
        return Status("idle", System.currentTimeMillis(), "", result.localChanged, result.conflicts).also(::publish)
    }

    private fun saveState(file: File, state: JSONObject) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(state.toString())
        tmp.renameTo(file)
    }

    /**
     * 이 Drive 폴더를 메모 폴더로 쓴다. importFrom 을 주면 지금까지의 휴대폰 메모를 함께 올린다.
     * 첫 동기화가 끝날 때까지 기다린다.
     */
    fun use(ctx: Context, folderId: String, name: String, importFrom: Storage?): Status {
        val mirror = mirrorDir(ctx, folderId)
        mirror.mkdirs()
        Vaults.prefs(ctx).edit().putString(KEY_FOLDER_NAME, name).apply()
        if (importFrom != null) copyAll(importFrom, FileStorage(mirror, ""))
        Vaults.use(ctx, PREFIX + folderId)
        val status = syncBlocking(ctx)
        schedule(ctx)
        return status
    }

    // 예전 메모 폴더의 파일을 새 폴더로 (같은 이름이 이미 있으면 두기)
    private fun copyAll(from: Storage, to: Storage) {
        fun walk(dir: String) {
            for (e in from.list(dir)) {
                if (SyncEngine.skipName(e.name)) continue
                val rel = if (dir.isEmpty()) e.name else "$dir/${e.name}"
                if (e.dir) walk(rel)
                else if (!SyncEngine.skipPath(rel) && to.stat(rel) == null) from.openRead(rel).use { input -> to.write(rel) { input.copyTo(it) } }
            }
        }
        walk("")
    }

    fun disconnect(ctx: Context) {
        GoogleAuth.signOut(ctx)
        cancelSchedule(ctx)
        publish(Status("off", status.lastSync, ""))
    }

    // ---------- 앱이 꺼져 있을 때: 시스템 작업 ----------

    fun schedule(ctx: Context) {
        if (!active(ctx)) return
        val js = ctx.getSystemService(JobScheduler::class.java) ?: return
        if (js.getPendingJob(JOB_ID) != null) return
        val job = JobInfo.Builder(JOB_ID, ComponentName(ctx, SyncJobService::class.java))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(15 * 60 * 1000L)
            .setPersisted(true)
            .build()
        // 배경 동기화를 못 걸어도(권한·제조사 제한) 화면이 보이는 동안의 동기화는 그대로 되게
        try {
            js.schedule(job)
        } catch (e: Exception) {
            android.util.Log.w("MemoKing", "배경 동기화를 예약하지 못했어요", e)
        }
    }

    fun cancelSchedule(ctx: Context) {
        ctx.getSystemService(JobScheduler::class.java)?.cancel(JOB_ID)
    }
}

class SyncJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        GoogleAuth.upgradeScope(this)
        if (!DriveSync.active(this) || !GoogleAuth.connected(this)) return false
        Thread {
            val status = DriveSync.syncBlocking(this)
            // 내려받은 메모에 알림이 바뀌었을 수 있다 — 다음에 앱을 열면 화면이 다시 계산해 맡긴다
            jobFinished(params, status.state == "error" && status.error.contains("인터넷"))
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters) = true
}
