package com.memoking.app.drive

import android.content.Context
import android.os.Build
import com.memoking.app.Storage
import com.memoking.app.Vaults
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/**
 * AI 받은함 (_memoking/AI 받은함 Google 시트) 네이티브 처리기.
 *   PC(desktop-rs/core/src/sheet_inbox.rs · vault/sheet_inbox.rs · drive.rs) 및
 *   JS(app/js/core/sheet-inbox.js · android/web/js/vault.js) 와 같은 규칙으로 동작하며,
 *   WebView 없이 백그라운드 동기화(SyncJobService)에서도 시트를 직접 처리한다.
 */
object SheetInbox {
    val COLUMNS = listOf("req_id", "action", "memo_id", "folder", "color", "body", "find", "status")
    val COLORS = setOf("yellow", "green", "pink", "purple", "blue", "gray", "charcoal")
    const val DEFAULT_COLOR = "yellow"
    const val BATCH = 20
    const val KEEP_DONE = 20
    private const val ALIVE_MS = 15 * 60_000L
    private const val DEVICES_DIR = "_memoking/기기"
    private const val KEY_DEVICE_ID = "sheetDeviceId"
    private val CONFLICT_TAG = Regex(""" \((?:PC|휴대폰) 충돌 \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)(?=\.md$)""")
    private val INVALID_FILE_CHARS = Regex("""[<>:"/\\|?*\u0000-\u001F]""")

    data class Row(
        val reqId: String = "",
        val action: String = "",
        val memoId: String = "",
        val folder: String = "",
        val color: String = "",
        val body: String = "",
        val find: String = "",
        val status: String = "",
    )

    sealed class Job {
        data class Create(val folder: String, val color: String, val body: String) : Job()
        data class Append(val memoId: String, val body: String) : Job()
        data class Replace(val memoId: String, val find: String, val body: String) : Job()
        data class Trash(val memoId: String) : Job()
    }

    data class PlanItem(val index: Int, val job: Job? = null, val error: String? = null)
    data class ApplyResult(val id: String? = null, val error: String? = null)
    data class RunOut(val csv: String, val done: Int)
    data class ProcessResult(val applied: Int = 0, val changedLocal: Boolean = false, val error: String = "")

    @Volatile private var seenId: String = ""
    @Volatile private var seenStamp: String = ""

    // ---------- RFC 4180 CSV 파싱 · 직렬화 ----------

    fun parseCsv(text: String): List<List<String>> {
        val s = text.removePrefix("\uFEFF")
        val rows = ArrayList<List<String>>()
        var row = ArrayList<String>()
        val cell = StringBuilder()
        var quoted = false
        var any = false
        var i = 0
        while (i < s.length) {
            val c = s[i]
            any = true
            if (quoted) {
                if (c == '"' && i + 1 < s.length && s[i + 1] == '"') {
                    cell.append('"')
                    i += 2
                    continue
                } else if (c == '"') {
                    quoted = false
                } else {
                    cell.append(c)
                }
                i++
                continue
            }
            when {
                c == '"' -> quoted = true
                c == ',' -> {
                    row.add(cell.toString())
                    cell.setLength(0)
                }
                c == '\r' && i + 1 < s.length && s[i + 1] == '\n' -> {
                    // \r\n 의 \r 건너뛰기
                }
                c == '\n' || c == '\r' -> {
                    row.add(cell.toString())
                    rows.add(row)
                    row = ArrayList()
                    cell.setLength(0)
                    any = false
                }
                else -> cell.append(c)
            }
            i++
        }
        if (any) {
            row.add(cell.toString())
            rows.add(row)
        }
        return rows
    }

    fun toCsv(rows: List<List<String>>): String {
        fun esc(s: String): String =
            if (s.any { it == ',' || it == '"' || it == '\n' || it == '\r' } || s.startsWith(' ') || s.endsWith(' ')) {
                "\"${s.replace("\"", "\"\"")}\""
            } else {
                s
            }
        return rows.joinToString("") { r -> "${r.joinToString(",", transform = ::esc)}\r\n" }
    }

    /** 예전 7열 헤더(color 열 누락)인지 확인 */
    fun needsHeaderUpgrade(text: String): Boolean {
        val header = parseCsv(text).firstOrNull()?.map { it.trim().lowercase(Locale.ROOT) } ?: return false
        return "req_id" in header && "color" !in header
    }

    /**
     * 시트 CSV → Row 목록.
     *   첫 줄에 req_id 가 있으면 열 이름으로 매핑하되, 예전 7열 헤더(color 없음) 시트에
     *   8열 형식 행(H열에 pending 등 상태값, G열 비어 있음)이 들어온 경우 8열 위치로 자동 보정한다.
     */
    fun rowsFromCsv(text: String): List<Row> {
        val cells = parseCsv(text)
        val header = cells.firstOrNull()?.map { it.trim().lowercase(Locale.ROOT) } ?: emptyList()
        val named = "req_id" in header
        val at = COLUMNS.mapIndexed { i, name -> if (named) header.indexOf(name) else i }
        val legacyNoColor = named && at[4] < 0 && at[7] >= 0
        val data = if (named) cells.drop(1) else cells
        return data
            .filter { row -> row.any { it.trim().isNotEmpty() } }
            .map { c ->
                val shifted8 = legacyNoColor && c.size >= 8 &&
                    (c.getOrNull(at[7])?.trim().orEmpty().isEmpty()) &&
                    c[7].trim().isNotEmpty()
                fun get(i: Int): String {
                    val idx = if (shifted8) i else at[i]
                    return if (idx in c.indices) c[idx] else ""
                }
                Row(
                    reqId = get(0),
                    action = get(1),
                    memoId = get(2),
                    folder = get(3),
                    color = get(4),
                    body = get(5),
                    find = get(6),
                    status = get(7),
                )
            }
    }

    fun rowsToCsv(rows: List<Row>): String {
        val all = ArrayList<List<String>>(rows.size + 1)
        all.add(COLUMNS)
        for (r in rows) {
            all.add(listOf(r.reqId, r.action, r.memoId, r.folder, r.color, r.body, r.find, r.status))
        }
        return toCsv(all)
    }

    private fun isPending(r: Row) = r.status.trim().equals("pending", ignoreCase = true)

    fun cleanFolderName(raw: String): String {
        val s = INVALID_FILE_CHARS.replace(raw.trim(), " ").replace(Regex("\\s+"), " ").trim().trimEnd('.')
        return if (s.length > 40) s.substring(0, 40).trim() else s
    }

    fun plan(rows: List<Row>): List<PlanItem> {
        val seen = rows.filterNot(::isPending).map { it.reqId.trim() }.toMutableSet()
        val out = ArrayList<PlanItem>()
        for ((index, r) in rows.withIndex()) {
            if (out.size >= BATCH) break
            if (!isPending(r)) continue
            val id = r.reqId.trim()
            when {
                id.isEmpty() -> out.add(PlanItem(index, error = "req_id 가 비었어요"))
                !seen.add(id) -> out.add(PlanItem(index, error = "이미 처리한 req_id 예요"))
                else -> out.add(jobOf(index, r))
            }
        }
        return out
    }

    private fun jobOf(index: Int, r: Row): PlanItem {
        val memoId = r.memoId.trim()
        fun needMemo(): String? = when {
            memoId.isEmpty() -> "memo_id 가 비었어요"
            '/' in memoId || '\\' in memoId || ".." in memoId -> "쓸 수 없는 memo_id 예요"
            else -> null
        }
        val body = r.body.trim()
        return when (val action = r.action.trim().lowercase(Locale.ROOT)) {
            "create" -> {
                if (body.isEmpty()) return PlanItem(index, error = "body 가 비었어요")
                val raw = r.folder.trim()
                val folder = cleanFolderName(raw)
                if ('/' in raw || '\\' in raw || ".." in raw || "_memoking" in raw.lowercase(Locale.ROOT) || (raw.isNotEmpty() && folder.isEmpty())) {
                    return PlanItem(index, error = "쓸 수 없는 folder 예요 (/ \\ .. _memoking 은 안 돼요)")
                }
                val rawColor = r.color.trim().lowercase(Locale.ROOT)
                if (rawColor.isNotEmpty() && rawColor !in COLORS) {
                    return PlanItem(index, error = "쓸 수 없는 color 예요 (${COLORS.joinToString(" · ")} 중 하나)")
                }
                PlanItem(index, job = Job.Create(folder, rawColor.ifEmpty { DEFAULT_COLOR }, body))
            }
            "append" -> {
                needMemo()?.let { return PlanItem(index, error = it) }
                if (body.isEmpty()) return PlanItem(index, error = "body 가 비었어요")
                PlanItem(index, job = Job.Append(memoId, body))
            }
            "replace" -> {
                needMemo()?.let { return PlanItem(index, error = it) }
                if (r.find.isEmpty()) return PlanItem(index, error = "find 가 비었어요")
                PlanItem(index, job = Job.Replace(memoId, r.find, r.body))
            }
            "trash" -> {
                needMemo()?.let { return PlanItem(index, error = it) }
                PlanItem(index, job = Job.Trash(memoId))
            }
            "" -> PlanItem(index, error = "action 이 비었어요")
            else -> PlanItem(index, error = "모르는 action 이에요 ($action). create · append · replace · trash 중 하나")
        }
    }

    fun finish(rows: List<Row>, results: List<Pair<Int, ApplyResult>>): List<Row> {
        val next = rows.toMutableList()
        for ((index, res) in results) {
            if (index in next.indices) {
                val st = if (res.error != null) "error: ${res.error}" else "done (${res.id})"
                next[index] = next[index].copy(status = st)
            }
        }
        var drop = maxOf(0, next.count { !isPending(it) } - KEEP_DONE)
        return next.filter { r ->
            if (drop > 0 && !isPending(r)) {
                drop--
                false
            } else {
                true
            }
        }
    }

    fun replaceOnce(text: String, find: String, replacement: String): Pair<String?, String?> {
        var count = 0
        var pos = 0
        while (true) {
            val idx = text.indexOf(find, pos)
            if (idx < 0) break
            count++
            pos = idx + find.length
        }
        return when {
            count == 0 -> null to "find 가 본문에 없어요"
            count > 1 -> null to "find 가 본문에 ${count}번 있어요 (한 번만 있는 글로 적어 주세요)"
            else -> text.replaceFirst(find, replacement) to null
        }
    }

    fun appendText(body: String, add: String): String = "${body.trim()}\n${add.trim()}"

    fun runSheet(csv: String, apply: (Job, String) -> ApplyResult): RunOut? {
        val rows = rowsFromCsv(csv)
        val todo = plan(rows)
        if (todo.isEmpty()) return null
        val results = todo.map { item ->
            if (item.error != null) {
                item.index to ApplyResult(error = item.error)
            } else {
                val res = try {
                    apply(item.job!!, rows[item.index].reqId.trim())
                } catch (e: Exception) {
                    ApplyResult(error = "처리하지 못했어요 (${e.message ?: e})")
                }
                item.index to res
            }
        }
        val done = results.count { it.second.error == null }
        return RunOut(rowsToCsv(finish(rows, results)), done)
    }

    // ---------- 기기 리더 선출 (충돌 사본 제외) ----------

    data class DeviceEntry(val file: String, val kind: String, val alive: Long)

    fun isConflictDeviceFile(file: String): Boolean = CONFLICT_TAG.containsMatchIn(file)

    fun inboxLeader(devices: List<DeviceEntry>, meFile: String, meKind: String, now: Long): Boolean {
        val live = devices
            .filter { it.file != meFile && !isConflictDeviceFile(it.file) && now - it.alive <= ALIVE_MS }
            .plus(DeviceEntry(meFile, meKind, now))
        val pcs = live.filter { it.kind == "pc" }
        val pool = if (pcs.isNotEmpty()) pcs else live
        return pool.minByOrNull { it.file }?.file == meFile
    }

    private fun myDeviceFile(ctx: Context): String {
        val prefs = Vaults.prefs(ctx)
        val id = prefs.getString(KEY_DEVICE_ID, null)?.takeIf { it.isNotEmpty() } ?: run {
            val fresh = UUID.randomUUID().toString().replace("-", "").take(4)
            prefs.edit().putString(KEY_DEVICE_ID, fresh).apply()
            fresh
        }
        val model = (Build.MODEL ?: "휴대폰").ifBlank { "휴대폰" }
        return "$DEVICES_DIR/${titleToFileName("$model ($id)")}.md"
    }

    fun isInboxLeader(ctx: Context, storage: Storage, now: Long = System.currentTimeMillis()): Boolean {
        val list = try {
            storage.list(DEVICES_DIR)
        } catch (e: Exception) {
            emptyList()
        }
        val parsed = list.mapNotNull { e ->
            if (e.dir || !e.name.endsWith(".md")) return@mapNotNull null
            val rel = "$DEVICES_DIR/${e.name}"
            if (isConflictDeviceFile(rel)) return@mapNotNull null
            val text = try {
                storage.openRead(rel).use { it.readBytes().toString(Charsets.UTF_8) }
            } catch (ex: Exception) {
                return@mapNotNull null
            }
            parseDevice(rel, text)
        }
        // WebView 의 device.js 가 만든 이 기기의 파일이 이미 있으면 그 파일 이름을 그대로 쓴다
        val model = (Build.MODEL ?: "휴대폰").ifBlank { "휴대폰" }
        val existingMine = parsed
            .filter { it.kind == "phone" && it.file.startsWith("$DEVICES_DIR/${titleToFileName(model)} (") }
            .maxByOrNull { it.alive }
            ?.file
        val meFile = existingMine ?: myDeviceFile(ctx)
        return inboxLeader(parsed, meFile, "phone", now)
    }

    private fun parseDevice(file: String, text: String): DeviceEntry? {
        val norm = text.replace("\r\n", "\n")
        if (!norm.startsWith("---\n")) return null
        val end = norm.indexOf("\n---\n", 4)
        if (end < 0) return null
        val head = norm.substring(4, end)
        var kind = "phone"
        var alive: Long? = null
        for (line in head.split('\n')) {
            val sep = line.indexOf(": ")
            if (sep <= 0) continue
            val k = line.substring(0, sep).trim()
            val v = line.substring(sep + 2).trim()
            if (k == "kind" && v == "pc") kind = "pc"
            if (k == "alive") alive = v.toLongOrNull()
        }
        return alive?.let { DeviceEntry(file, kind, it) }
    }

    // ---------- 로컬 볼트(Storage) 반영 ----------

    private fun isLockedBody(body: String): Boolean = "<!-- memoking-lock" in body

    private fun localIso(now: Long = System.currentTimeMillis()): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.ROOT)
        return sdf.format(Date(now))
    }

    private fun extractTitle(body: String): String {
        val line = body.replace("\r\n", "\n").split('\n')
            .map { it.trim() }
            .firstOrNull { it.isNotEmpty() } ?: "제목 없음"
        return line.replace(Regex("^#+\\s*"), "").trim().ifEmpty { "제목 없음" }
    }

    private fun titleToFileName(title: String): String {
        val cleaned = INVALID_FILE_CHARS.replace(title, " ").replace(Regex("\\s+"), " ").trim().trimEnd('.')
        val clipped = if (cleaned.length > 80) cleaned.substring(0, 80).trim() else cleaned
        return clipped.ifEmpty { "제목 없음" }
    }

    private fun splitFrontmatter(raw: String): Pair<String?, String> {
        val norm = raw.replace("\r\n", "\n")
        if (!norm.startsWith("---\n")) return null to norm
        val end = norm.indexOf("\n---\n", 4)
        if (end < 0) return null to norm
        return norm.substring(4, end) to norm.substring(end + 5)
    }

    private fun frontmatterId(head: String?): String? {
        if (head == null) return null
        for (line in head.split('\n')) {
            val sep = line.indexOf(':')
            if (sep <= 0) continue
            if (line.substring(0, sep).trim() == "id") return line.substring(sep + 1).trim().trim('"', '\'')
        }
        return null
    }

    private fun updateFrontmatterTimestamp(head: String, nowIso: String): String {
        val lines = head.split('\n').toMutableList()
        val idx = lines.indexOfFirst { it.trimStart().startsWith("updated:") }
        if (idx >= 0) lines[idx] = "updated: $nowIso" else lines.add("updated: $nowIso")
        return lines.joinToString("\n")
    }

    private fun findMemoById(storage: Storage, targetId: String): Triple<String, String?, String>? {
        fun scanDir(dir: String): Triple<String, String?, String>? {
            for (e in storage.list(dir)) {
                val rel = if (dir.isEmpty()) e.name else "$dir/${e.name}"
                if (e.dir) {
                    if (dir.isEmpty() && SyncEngine.userDir(e.name)) {
                        scanDir(rel)?.let { return it }
                    }
                    continue
                }
                if (!e.name.endsWith(".md")) continue
                val text = try {
                    storage.openRead(rel).use { it.readBytes().toString(Charsets.UTF_8) }
                } catch (ex: Exception) {
                    continue
                }
                val (head, body) = splitFrontmatter(text)
                if (frontmatterId(head) == targetId) return Triple(rel, head, body)
            }
            return null
        }
        return scanDir("")
    }

    private fun uniqueMemoPath(storage: Storage, folder: String, baseName: String): String {
        val prefix = if (folder.isEmpty()) "" else "$folder/"
        var n = 1
        while (true) {
            val candidate = if (n == 1) "$prefix$baseName.md" else "$prefix$baseName ($n).md"
            if (storage.stat(candidate) == null) return candidate
            n++
        }
    }

    private fun keepVersion(storage: Storage, memoId: String, oldBody: String) {
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(Date())
        val dir = "_memoking/versions/$memoId"
        storage.mkdirs(dir)
        val rel = "$dir/$stamp.md"
        storage.write(rel) { it.write(oldBody.toByteArray(Charsets.UTF_8)) }
    }

    fun applyJob(storage: Storage, job: Job): ApplyResult = DriveSync.withFiles {
        when (job) {
            is Job.Create -> {
                if (isLockedBody(job.body)) return@withFiles ApplyResult(error = "잠금 형식 글은 만들 수 없어요")
                val id = UUID.randomUUID().toString()
                val nowIso = localIso()
                val title = extractTitle(job.body)
                if (job.folder.isNotEmpty()) storage.mkdirs(job.folder)
                val rel = uniqueMemoPath(storage, job.folder, titleToFileName(title))
                val content = "---\nid: $id\ncreated: $nowIso\nupdated: $nowIso\ncolor: ${job.color}\ndevice: ai\n---\n${job.body.trimEnd()}\n"
                storage.write(rel) { it.write(content.toByteArray(Charsets.UTF_8)) }
                ApplyResult(id = id)
            }
            is Job.Append -> {
                val (rel, head, oldBody) = findMemoById(storage, job.memoId)
                    ?: return@withFiles ApplyResult(error = "그런 memo_id 의 메모가 없어요")
                if (isLockedBody(oldBody)) return@withFiles ApplyResult(error = "잠긴 메모는 고칠 수 없어요")
                val nextBody = appendText(oldBody, job.body)
                keepVersion(storage, job.memoId, oldBody)
                val newHead = updateFrontmatterTimestamp(head ?: "id: ${job.memoId}", localIso())
                val content = "---\n$newHead\n---\n${nextBody.trimEnd()}\n"
                storage.write(rel) { it.write(content.toByteArray(Charsets.UTF_8)) }
                ApplyResult(id = job.memoId)
            }
            is Job.Replace -> {
                val (rel, head, oldBody) = findMemoById(storage, job.memoId)
                    ?: return@withFiles ApplyResult(error = "그런 memo_id 의 메모가 없어요")
                if (isLockedBody(oldBody)) return@withFiles ApplyResult(error = "잠긴 메모는 고칠 수 없어요")
                val (replaced, err) = replaceOnce(oldBody, job.find, job.body)
                if (err != null) return@withFiles ApplyResult(error = err)
                keepVersion(storage, job.memoId, oldBody)
                val newHead = updateFrontmatterTimestamp(head ?: "id: ${job.memoId}", localIso())
                val content = "---\n$newHead\n---\n${replaced!!.trimEnd()}\n"
                storage.write(rel) { it.write(content.toByteArray(Charsets.UTF_8)) }
                ApplyResult(id = job.memoId)
            }
            is Job.Trash -> {
                val (rel, _, oldBody) = findMemoById(storage, job.memoId)
                    ?: return@withFiles ApplyResult(error = "그런 memo_id 의 메모가 없어요")
                if (isLockedBody(oldBody)) return@withFiles ApplyResult(error = "잠긴 메모는 고칠 수 없어요")
                storage.mkdirs("_memoking/trash")
                val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(Date())
                val base = rel.substringAfterLast('/').removeSuffix(".md")
                var n = 1
                var dst: String
                while (true) {
                    dst = "_memoking/trash/$base${if (n > 1) " ($n)" else ""} ($stamp).md"
                    if (storage.stat(dst) == null) break
                    n++
                }
                if (storage.move(rel, dst)) ApplyResult(id = job.memoId)
                else ApplyResult(error = "휴지통으로 옮기지 못했어요")
            }
        }
    }

    // ---------- 시트 처리 실행 (낙관적 잠금 + 멱등 캐시) ----------

    private fun appliedFile(ctx: Context, folderId: String) = File(File(ctx.filesDir, "drive"), "$folderId.sheet-applied.json")

    private fun loadApplied(file: File): LinkedHashMap<String, ApplyResult> {
        val map = LinkedHashMap<String, ApplyResult>()
        try {
            if (!file.exists()) return map
            val arr = JSONArray(file.readText())
            for (i in 0 until arr.length()) {
                val item = arr.optJSONArray(i) ?: continue
                val key = item.optString(0)
                if (key.isEmpty()) continue
                val id = item.optString(1).ifEmpty { null }
                val err = item.optString(2).ifEmpty { null }
                map[key] = ApplyResult(id = id, error = err)
            }
        } catch (e: Exception) {
            // 손상된 캐시는 무시
        }
        return map
    }

    private fun saveApplied(file: File, map: LinkedHashMap<String, ApplyResult>) {
        try {
            file.parentFile?.mkdirs()
            val entries = map.entries.toList().takeLast(200)
            val arr = JSONArray()
            for ((k, v) in entries) {
                arr.put(JSONArray().put(k).put(v.id ?: "").put(v.error ?: ""))
            }
            val tmp = File(file.parentFile, "${file.name}.tmp")
            tmp.writeText(arr.toString())
            tmp.renameTo(file)
        } catch (e: Exception) {
            android.util.Log.w("MemoKing", "시트 처리 이력 저장 실패", e)
        }
    }

    /** DriveSync.runNow() 말미에서 호출 — 포그라운드·백그라운드(SyncJobService) 공통 */
    fun process(ctx: Context, api: DriveApi, storage: Storage, folderId: String, memokingId: String): ProcessResult {
        var id = seenId.ifEmpty { api.ensureSheet(memokingId) }
        val stamp = try {
            api.fileStamp(id)
        } catch (e: DriveApi.HttpError) {
            if (e.code != 404) throw e
            seenId = ""
            seenStamp = ""
            id = api.ensureSheet(memokingId)
            api.fileStamp(id)
        }
        if (id == seenId && stamp == seenStamp) return ProcessResult()

        val csv = api.exportCsv(id)
        val cacheFile = appliedFile(ctx, folderId)
        val applied = loadApplied(cacheFile)
        val before = applied.size
        var touchedLocal = false

        val out = runSheet(csv) { job, reqId ->
            applied[reqId]?.let { return@runSheet it }
            val r = applyJob(storage, job)
            if (r.error == null) touchedLocal = true
            applied[reqId] = r
            r
        }
        if (applied.size != before) saveApplied(cacheFile, applied)

        if (out == null) {
            // pending 은 없지만 예전 7열 헤더인 경우 8열 헤더로 자동 마이그레이션
            if (needsHeaderUpgrade(csv)) {
                val upgraded = rowsToCsv(rowsFromCsv(csv))
                if (api.fileStamp(id) == stamp) {
                    api.updateCsv(id, upgraded)
                    seenId = id
                    seenStamp = ""
                    return ProcessResult()
                }
            }
            seenId = id
            seenStamp = stamp
            return ProcessResult()
        }

        // 낙관적 잠금: 읽은 뒤 시트가 그대로일 때만 결과 CSV 덮어쓰기
        if (api.fileStamp(id) == stamp) {
            api.updateCsv(id, out.csv)
            seenId = id
            seenStamp = "" // 덮어쓴 직후 AI 가 추가한 줄도 놓치지 않게 다음 차례에 한 번 더 확인
        }
        return ProcessResult(applied = out.done, changedLocal = touchedLocal || out.done > 0)
    }
}
