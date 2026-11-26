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
import com.memoking.app.VaultFileProvider
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
    /** 메모킹이 Drive 에 만드는 폴더 (PC 와 같은 이름 — desktop-rs/app/src/drive.rs) */
    const val SYNC_FOLDER = "메모킹 동기화"
    private const val KEY_FOLDER_NAME = "driveFolderName"
    private const val JOB_ID = 4201

    data class Status(
        val state: String, // off | idle | syncing | error
        val lastSync: Long,
        val error: String,
        val changed: Boolean = false,
        val conflicts: List<String> = emptyList(),
        val progress: JSONObject? = null, // 동기화하는 동안 { phase, done, total, since } (PC drive.rs 와 같은 모양 — app/js/core/sync-progress.js)
        val sheetApplied: Int = 0, // 이번 동기화에서 네이티브로 반영한 AI 받은함 요청 수
        val sheetError: String = "", // AI 받은함 처리 오류 (있으면 화면 토스트 · 기기 상태에 노출)
    ) {
        fun json(): JSONObject = JSONObject().put("state", state).put("lastSync", lastSync).put("error", error)
            .put("changed", changed).put("conflicts", org.json.JSONArray(conflicts)).put("progress", progress ?: JSONObject.NULL)
            .put("sheetApplied", sheetApplied).put("sheetError", sheetError)
    }

    private val worker = Executors.newSingleThreadScheduledExecutor()

    /** 메모 파일을 쓸 때 잡는 잠금 — 앱(Bridge · 위젯)의 저장과 동기화의 "그대로인지 확인 → 바꿔치기" 가 서로 끼어들지 않게 (PC 의 메모 잠금과 같음) */
    private val fileLock = Any()

    fun <T> withFiles(f: () -> T): T = synchronized(fileLock, f)

    /** 안전장치로 멈추면 자동 동기화는 5분 쉰다 — 같은 모습이면 다시 해도 또 멈추며 폴더만 계속 훑는다 ("지금 동기화" · 폴더를 바꾸면 바로. PC drive.rs 와 같음) */
    @Volatile private var holdUntil = 0L
    private var pending: ScheduledFuture<*>? = null

    /** 파일이 오간 뒤 이때까지는 화면이 보이는 동안 5초마다 (PC 와 주고받는 중일 때 빨리) */
    @Volatile var burstUntil = 0L

    /** 화면이 보이는 동안 다음 동기화까지 — 보통 10초, 파일이 오간 뒤 2분은 5초 (PC 와 같음) */
    fun pollDelay(now: Long = System.currentTimeMillis()): Long = if (now < burstUntil) 5_000 else 10_000
    @Volatile var status = Status("off", 0, "")
        private set

    /** 상태가 바뀔 때마다 (화면에 알리기) */
    @Volatile var listener: ((Status) -> Unit)? = null

    fun folderId(ctx: Context): String? = Vaults.spec(ctx)?.takeIf { it.startsWith(PREFIX) }?.removePrefix(PREFIX)
    fun active(ctx: Context) = folderId(ctx) != null
    fun folderName(ctx: Context): String = Vaults.prefs(ctx).getString(KEY_FOLDER_NAME, "") ?: ""

    fun mirrorDir(ctx: Context, folderId: String) = File(File(ctx.filesDir, "drive"), folderId)
    private fun stateFile(ctx: Context, folderId: String) = File(File(ctx.filesDir, "drive"), "$folderId.state.json")

    /**
     * AI 받은함 시트 (화면 android/web/js/sheet-inbox.js 가 처리를 맡는다 — 받은 메모 담당 기기일 때만):
     *   fetch: 시트가 since 그대로면 { id, stamp }, 바뀌었으면 CSV 까지 { id, stamp, csv } (시트가 없으면 만든다)
     *   update: 읽은 뒤 시트가 그대로(stamp)일 때만 csv 로 덮어쓴다 → { ok } | { changed } (바뀌었으면 다음 차례에)
     */
    fun sheetInbox(ctx: Context, a: JSONObject): JSONObject {
        val folderId = folderId(ctx) ?: throw IllegalStateException("Google Drive 와 맞추고 있지 않아요")
        val api = DriveApi(ctx)
        return when (a.optString("op")) {
            "fetch" -> {
                val memoking = try { JSONObject(stateFile(ctx, folderId).readText()).optJSONObject("folders")?.optString("_memoking") } catch (e: Exception) { null }
                    ?.takeIf { it.isNotEmpty() } ?: return JSONObject() // 아직 한 번도 맞추지 않았다 (_memoking 폴더를 모름)
                var id = a.optString("id").ifEmpty { api.ensureSheet(memoking) }
                val stamp = try {
                    api.fileStamp(id)
                } catch (e: DriveApi.HttpError) {
                    if (e.code != 404) throw e
                    id = api.ensureSheet(memoking) // 시트를 지웠다 — 다시 찾거나 만든다
                    api.fileStamp(id)
                }
                val out = JSONObject().put("id", id).put("stamp", stamp)
                if (stamp != a.optString("since")) out.put("csv", api.exportCsv(id))
                out
            }
            "update" -> {
                val id = a.getString("id")
                if (api.fileStamp(id) != a.getString("stamp")) return JSONObject().put("changed", true)
                api.updateCsv(id, a.getString("csv"))
                JSONObject().put("ok", true)
            }
            else -> throw IllegalArgumentException("모르는 일이에요")
        }
    }

    fun storage(ctx: Context, folderId: String): Storage =
        FileStorage(mirrorDir(ctx, folderId), "Google Drive › ${folderName(ctx).ifEmpty { "메모 폴더" }}", VaultFileProvider.driveRoot(folderId))

    private fun publish(next: Status) {
        status = next
        listener?.invoke(next)
    }

    private fun progress(phase: String, done: Int, total: Int, since: Long) =
        JSONObject().put("phase", phase).put("done", done).put("total", total).put("since", since)

    private var progressSent = 0L

    /** 엔진의 진행 (여러 줄에서 온다): 처음 · 마지막 · 단계가 바뀔 때는 바로, 그 사이는 0.3초에 한 번만 화면에 (PC drive.rs 와 같음) */
    @Synchronized
    private fun onProgress(phase: String, done: Int, total: Int) {
        val prev = status.progress
        val now = System.currentTimeMillis()
        val turned = prev?.optString("phase") != phase
        val next = status.copy(progress = progress(phase, done, total, if (turned) now else prev!!.optLong("since", now))) // 남은 시간은 단계마다 따로
        if (turned || done == 0 || done == total || now - progressSent >= 300) {
            progressSent = now
            publish(next)
        } else {
            status = next
        }
    }

    /** 동기화를 부탁한다 (delayMs 안에 또 부탁하면 한 번으로) */
    @Synchronized
    fun request(ctx: Context, delayMs: Long = 0) {
        if (!active(ctx) || !GoogleAuth.connected(ctx) || System.currentTimeMillis() < holdUntil) return
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
        publish(status.copy(state = "syncing", changed = false, conflicts = emptyList(), progress = progress("scan", 0, 0, System.currentTimeMillis())))
        val file = stateFile(ctx, folderId)
        val state = try {
            JSONObject(file.readText())
        } catch (e: Exception) {
            JSONObject()
        }
        // 권한이 Drive 전체 → drive.file 로 줄었으면 다른 앱이 넣은 파일이 목록에서 사라져 보인다 —
        //   "Drive 에서 지움" 으로 휴대폰 메모를 지우지 않고 메모킹 파일로 다시 올린다 (한 번 다 끝낼 때까지)
        val scope = if (GoogleAuth.grantedScope(ctx) == GoogleAuth.FULL_SCOPE) "full" else "file"
        if (state.optString("scope") == "full" && scope == "file") state.put("keepMissing", true)
        state.put("scope", scope)
        val result = try {
            SyncEngine(storage(ctx, folderId), DriveApi(ctx), folderId, state, fileLock, ::onProgress).run(full)
        } catch (e: Exception) {
            android.util.Log.w("MemoKing", "Drive 동기화 실패", e)
            saveState(file, state)
            holdUntil = if (e is SyncEngine.SafetyStop) System.currentTimeMillis() + 5 * 60_000 else 0
            val message = when (e) {
                is java.net.UnknownHostException, is java.net.ConnectException, is java.net.SocketTimeoutException -> "인터넷에 연결되지 않아 동기화하지 못했어요"
                else -> e.message ?: "동기화하지 못했어요"
            }
            return Status("error", status.lastSync, message).also(::publish)
        }
        saveState(file, state)
        holdUntil = 0
        if (result.uploaded + result.downloaded + result.deletedLocal + result.deletedRemote > 0) burstUntil = System.currentTimeMillis() + 120_000
        if (result.downloaded > 0) {
            // 다른 기기에서 잠근 메모를 홈 화면 위젯에서 바로 숨김 — 위젯의 파일 일은 한 줄로(체크·내용 보내기와 서로 덮어쓰지 않게),
            // 동기화가 끝났다고 알리기 전에 마친다 (그 뒤 앱이 바로 꺼져도 풀린 글이 위젯에 남지 않게)
            try {
                com.memoking.app.Widgets.io.submit<Unit> { com.memoking.app.Widgets.hideLocked(ctx) }.get(20, TimeUnit.SECONDS)
            } catch (e: Exception) {
                android.util.Log.w("MemoKing", "위젯 확인 실패", e)
            }
        }
        // AI 받은함 시트: 포그라운드 · 백그라운드(SyncJobService) 모두 네이티브에서 직접 처리 (PC drive.rs 와 같음)
        var sheetApplied = 0
        var sheetError = ""
        var localChanged = result.localChanged
        val memokingId = state.optJSONObject("folders")?.optString("_memoking")?.takeIf { it.isNotEmpty() }
        if (memokingId != null) {
            val store = storage(ctx, folderId)
            if (SheetInbox.isInboxLeader(ctx, store)) {
                try {
                    val sheetRes = SheetInbox.process(ctx, DriveApi(ctx), store, folderId, memokingId)
                    sheetApplied = sheetRes.applied
                    if (sheetRes.changedLocal) {
                        localChanged = true
                        // 새로 만들고 고친 메모를 바로 Drive 에 올린다 (백그라운드에서도 즉시 반영되도록)
                        try {
                            val push = SyncEngine(store, DriveApi(ctx), folderId, state, fileLock, ::onProgress).run(false)
                            saveState(file, state)
                            if (push.uploaded + push.downloaded + push.deletedLocal + push.deletedRemote > 0) {
                                burstUntil = System.currentTimeMillis() + 120_000
                            }
                        } catch (e: Exception) {
                            android.util.Log.w("MemoKing", "AI 받은함 반영 후 업로드 실패", e)
                        }
                    }
                } catch (e: Exception) {
                    android.util.Log.w("MemoKing", "AI 받은함 처리 실패", e)
                    sheetError = e.message ?: "AI 받은함 시트를 처리하지 못했어요"
                }
            }
        }
        GoogleAuth.ensureEmail(ctx)
        return Status("idle", System.currentTimeMillis(), "", localChanged, result.conflicts, sheetApplied = sheetApplied, sheetError = sheetError).also(::publish)
    }

    private fun saveState(file: File, state: JSONObject) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(state.toString())
        tmp.renameTo(file)
    }

    /**
     * 이 Drive 폴더를 메모 폴더로 쓴다. importFrom 을 주면 지금까지의 휴대폰 메모를 함께 올린다.
     * wait: 첫 동기화가 끝날 때까지 기다린다. false 면 폴더만 정하고 바로 돌아오며 동기화는 뒤에서 (처음 화면 —
     *   메모가 많아도 목록에 바로 들어가 쓰고, 받은 메모는 "sync" 소식으로 화면이 다시 읽는다)
     */
    fun use(ctx: Context, folderId: String, name: String, importFrom: Storage?, wait: Boolean = true): Status {
        val mirror = mirrorDir(ctx, folderId)
        mirror.mkdirs()
        Vaults.prefs(ctx).edit().putString(KEY_FOLDER_NAME, name).apply()
        if (importFrom != null) copyAll(importFrom, FileStorage(mirror, ""))
        Vaults.use(ctx, PREFIX + folderId)
        holdUntil = 0
        if (!wait) {
            schedule(ctx)
            publish(status.copy(state = "syncing", changed = false, conflicts = emptyList()))
            request(ctx)
            return status
        }
        val first = syncBlocking(ctx)
        schedule(ctx)
        return first
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
            // 동기화 밖에서 난 오류(기록 저장 실패 등)로 배경 스레드가 죽으면 앱이 꺼진다 — 잡고 다음 차례에 다시
            val retry = try {
                val status = DriveSync.syncBlocking(this)
                status.state == "error" && status.error.contains("인터넷")
            } catch (e: Exception) {
                android.util.Log.w("MemoKing", "배경 동기화 실패", e)
                true
            }
            // 내려받은 메모에 알림이 바뀌었을 수 있다 — 다음에 앱을 열면 화면이 다시 계산해 맡긴다
            jobFinished(params, retry)
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters) = true
}
