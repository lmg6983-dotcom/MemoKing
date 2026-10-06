package com.memoking.app.drive

import com.memoking.app.Storage
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Google Drive 쪽 (테스트에서는 가짜로 바꿔 끼운다) */
interface Remote {
    data class Item(val id: String, val name: String, val folder: Boolean, val md5: String?, val modified: Long, val size: Long)

    fun listChildren(folderId: String): List<Item>
    fun download(id: String, out: OutputStream)

    /** existingId 가 있으면 그 파일 내용을 바꾸고, 없으면 parentId 안에 새로 만든다 */
    fun upload(parentId: String, name: String, existingId: String?, size: Long, open: () -> InputStream): Item
    fun createFolder(parentId: String, name: String): Item
    fun trash(id: String)

    /** 지난 토큰 이후 바뀐 것이 있는가 (knownIds 에 든 파일·폴더만 따진다). 새 토큰을 돌려준다 */
    fun changesSince(token: String?, knownIds: Set<String>): Pair<Boolean, String>
}

/**
 * 메모 폴더(휴대폰) ↔ Google Drive 폴더 양방향 동기화.
 *
 * 지난번 동기화 때의 모습(기준)을 기억해 두고, 파일마다 양쪽이 기준에서 바뀌었는지 보고 정한다:
 *   한쪽만 바뀜 → 그쪽 것을 다른 쪽에 반영 (올리기·내려받기·지우기)
 *   양쪽 다 바뀜 → 내용이 같으면 그대로, 다르면 Drive(PC) 것을 남기고 휴대폰 것은 "(휴대폰 충돌 …)" 사본으로
 * Drive 에서 지울 때는 휴지통으로 보낸다 (Drive 웹에서 되살릴 수 있음).
 * 한쪽에서 파일이 한꺼번에 많이 사라지면(연결 오류·잘못 고른 폴더) 아무것도 지우지 않고 멈춘다.
 */
class SyncEngine(
    private val local: Storage,
    private val remote: Remote,
    private val rootId: String,
    private val state: JSONObject, // { pageToken, files: { 경로: { id, md5, lmtime, lsize } } }
    private val now: () -> Long = System::currentTimeMillis,
) {
    data class Result(
        val uploaded: Int = 0,
        val downloaded: Int = 0,
        val deletedLocal: Int = 0,
        val deletedRemote: Int = 0,
        val conflicts: List<String> = emptyList(),
        val skipped: Boolean = false,
    ) {
        /** 휴대폰 메모 폴더가 바뀌었는가 (화면이 다시 읽어야 하는가) */
        val localChanged get() = downloaded > 0 || deletedLocal > 0 || conflicts.isNotEmpty()
    }

    class SafetyStop(message: String) : Exception(message)

    companion object {
        const val FOLDER = "application/vnd.google-apps.folder"

        // 기기마다 따로 만드는 파일 — 서로 덮어쓰며 충돌하지 않게 동기화하지 않는다
        private val LOCAL_ONLY = setOf("_memoking/index.json")
        private const val MERGE_JSON = "_memoking/link-previews.json"
        private const val MASS_DELETE_MIN = 20

        fun skipName(name: String) = name.startsWith(".") || name.startsWith("~$") || name.endsWith(".tmp") || name == "desktop.ini" || name == "Thumbs.db"
        fun skipPath(rel: String) = rel in LOCAL_ONLY || rel.split('/').any(::skipName)

        fun md5(input: InputStream): String {
            val digest = MessageDigest.getInstance("MD5")
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }

    private val files: JSONObject = state.optJSONObject("files") ?: JSONObject().also { state.put("files", it) }
    private val folderIds = HashMap<String, String>() // 상대 경로 → Drive 폴더 id ("" = 메모 폴더)

    private data class Local(val mtime: Long, val size: Long)
    private data class Base(val id: String, val md5: String, val lmtime: Long, val lsize: Long)

    private fun base(rel: String): Base? = files.optJSONObject(rel)?.let {
        Base(it.optString("id"), it.optString("md5"), it.optLong("lmtime"), it.optLong("lsize"))
    }

    private fun record(rel: String, id: String, md5: String, l: Storage.Entry) {
        files.put(rel, JSONObject().put("id", id).put("md5", md5).put("lmtime", l.mtime).put("lsize", l.size))
    }

    // ---------- 양쪽 둘러보기 ----------

    private fun walkLocal(): Map<String, Local> {
        val out = HashMap<String, Local>()
        fun walk(dir: String) {
            for (e in local.list(dir)) {
                if (skipName(e.name)) continue
                val rel = if (dir.isEmpty()) e.name else "$dir/${e.name}"
                if (e.dir) walk(rel) else if (!skipPath(rel)) out[rel] = Local(e.mtime, e.size)
            }
        }
        walk("")
        return out
    }

    private fun walkRemote(): Map<String, Remote.Item> {
        val out = HashMap<String, Remote.Item>()
        folderIds[""] = rootId
        fun walk(folderId: String, dir: String) {
            // Drive 는 한 폴더에 같은 이름을 여러 개 둘 수 있다 — 가장 최근 것만 쓴다
            val byName = remote.listChildren(folderId).groupBy { it.name }.mapValues { (_, v) -> v.maxBy { it.modified } }
            for (item in byName.values) {
                if (skipName(item.name)) continue
                val rel = if (dir.isEmpty()) item.name else "$dir/${item.name}"
                if (item.folder) {
                    folderIds[rel] = item.id
                    walk(item.id, rel)
                } else if (item.md5 != null && !skipPath(rel)) {
                    out[rel] = item // md5 가 없는 것은 구글 문서 같은 Drive 전용 파일
                }
            }
        }
        walk(rootId, "")
        return out
    }

    private fun ensureRemoteFolder(dir: String): String {
        folderIds[dir]?.let { return it }
        val parent = ensureRemoteFolder(dir.substringBeforeLast('/', ""))
        val created = remote.createFolder(parent, dir.substringAfterLast('/'))
        folderIds[dir] = created.id
        return created.id
    }

    // ---------- 동기화 ----------

    fun run(): Result {
        val localFiles = walkLocal()
        val known = files.keys().asSequence().toList()
        val localDirty = localFiles.size != known.size || localFiles.any { (rel, l) ->
            val b = base(rel)
            b == null || b.lmtime != l.mtime || b.lsize != l.size
        }
        val knownIds = known.mapNotNull { files.optJSONObject(it)?.optString("id") }.toSet() +
            (state.optJSONObject("folders")?.let { f -> f.keys().asSequence().map { f.optString(it) }.toSet() } ?: emptySet()) + rootId
        val (remoteDirty, token) = remote.changesSince(state.optString("pageToken").ifEmpty { null }, knownIds)
        if (!localDirty && !remoteDirty) {
            state.put("pageToken", token)
            return Result(skipped = true)
        }

        val remoteFiles = walkRemote()
        val paths = (localFiles.keys + remoteFiles.keys + known).toSortedSet()

        // 한쪽에서 한꺼번에 많이 사라졌으면 멈춘다
        val goneRemote = paths.count { base(it) != null && it !in remoteFiles && it in localFiles }
        val goneLocal = paths.count { base(it) != null && it !in localFiles && it in remoteFiles }
        if (goneRemote >= MASS_DELETE_MIN && goneRemote * 2 > known.size) {
            throw SafetyStop("Google Drive 폴더에서 파일 ${goneRemote}개가 한꺼번에 사라져서 동기화를 멈췄어요. 고른 폴더가 맞는지 확인해 주세요.")
        }
        if (goneLocal >= MASS_DELETE_MIN && goneLocal * 2 > known.size) {
            throw SafetyStop("휴대폰 메모 폴더에서 파일 ${goneLocal}개가 한꺼번에 사라져서 동기화를 멈췄어요.")
        }

        var uploaded = 0
        var downloaded = 0
        var deletedLocal = 0
        var deletedRemote = 0
        val conflicts = ArrayList<String>()

        fun localMd5(rel: String) = local.openRead(rel).use(::md5)

        fun upload(rel: String, existingId: String?) {
            val before = local.stat(rel) ?: return
            val parent = ensureRemoteFolder(rel.substringBeforeLast('/', ""))
            val item = remote.upload(parent, rel.substringAfterLast('/'), existingId, before.size) { local.openRead(rel) }
            record(rel, item.id, item.md5 ?: "", before)
            uploaded++
        }

        fun download(rel: String, item: Remote.Item, expect: Local?) {
            // 둘러본 뒤 휴대폰에서 또 고쳤으면 이번에는 건드리지 않는다 (다음 차례에)
            val nowLocal = local.stat(rel)
            if (expect != null && (nowLocal == null || nowLocal.mtime != expect.mtime || nowLocal.size != expect.size)) return
            if (expect == null && nowLocal != null) return
            val entry = local.write(rel) { remote.download(item.id, it) }
            record(rel, item.id, item.md5 ?: "", entry)
            downloaded++
        }

        fun conflictName(rel: String): String {
            val stamp = SimpleDateFormat("yyyy-MM-dd HHmm", Locale.ROOT).format(Date(now()))
            val dir = rel.substringBeforeLast('/', "")
            val name = rel.substringAfterLast('/')
            val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
            var n = 1
            while (true) {
                val tag = if (n == 1) "휴대폰 충돌 $stamp" else "휴대폰 충돌 $stamp $n"
                val candidate = "${name.substring(0, dot)} ($tag)${name.substring(dot)}"
                val path = if (dir.isEmpty()) candidate else "$dir/$candidate"
                if (local.stat(path) == null) return path
                n++
            }
        }

        // 양쪽에서 다르게 바뀐 파일: 링크 미리보기 모음은 합치고, 나머지는 Drive 것을 남기고 휴대폰 것은 사본으로
        fun conflict(rel: String, item: Remote.Item, l: Local) {
            if (rel == MERGE_JSON) {
                val mine = try {
                    JSONObject(local.openRead(rel).use { it.readBytes().toString(Charsets.UTF_8) })
                } catch (e: Exception) {
                    JSONObject()
                }
                val theirs = try {
                    val out = java.io.ByteArrayOutputStream()
                    remote.download(item.id, out)
                    JSONObject(out.toString("UTF-8"))
                } catch (e: Exception) {
                    JSONObject()
                }
                for (k in mine.keys()) if (!theirs.has(k)) theirs.put(k, mine.get(k))
                local.write(rel) { it.write(theirs.toString(1).toByteArray(Charsets.UTF_8)) }
                upload(rel, item.id)
                return
            }
            val copy = conflictName(rel)
            if (!local.move(rel, copy)) return
            conflicts += copy
            download(rel, item, null)
            upload(copy, null)
        }

        for (rel in paths) {
            val l = localFiles[rel]
            val r = remoteFiles[rel]
            val b = base(rel)
            val localChanged = l != null && (b == null || b.lmtime != l.mtime || b.lsize != l.size)
            val remoteChanged = r != null && (b == null || b.md5 != r.md5)
            try {
                when {
                    l != null && r != null -> when {
                        !localChanged && !remoteChanged -> Unit
                        localChanged && !remoteChanged -> upload(rel, r.id)
                        !localChanged && remoteChanged -> download(rel, r, l)
                        else -> {
                            // 양쪽 다 새로 생겼거나 바뀜: 내용이 같으면 기억만
                            if (localMd5(rel) == r.md5) record(rel, r.id, r.md5, local.stat(rel)!!)
                            else conflict(rel, r, l)
                        }
                    }
                    l != null && r == null -> when {
                        b == null || localChanged -> upload(rel, null) // 새 파일, 또는 Drive 에서 지웠지만 휴대폰에서 고침 → 되살림
                        else -> {
                            // Drive(PC)에서 지움 → 휴대폰에서도
                            if (local.delete(rel)) deletedLocal++
                            files.remove(rel)
                        }
                    }
                    l == null && r != null -> when {
                        b == null || remoteChanged -> download(rel, r, null) // 새 파일, 또는 휴대폰에서 지웠지만 PC 에서 고침 → 되살림
                        else -> {
                            remote.trash(r.id)
                            deletedRemote++
                            files.remove(rel)
                        }
                    }
                    else -> files.remove(rel) // 양쪽 다 지움
                }
            } catch (e: SafetyStop) {
                throw e
            } catch (e: java.io.FileNotFoundException) {
                // 둘러보는 사이 없어진 파일 — 다음 차례에
            }
        }

        state.put("pageToken", token)
        state.put("folders", JSONObject(folderIds.toMap()))
        return Result(uploaded, downloaded, deletedLocal, deletedRemote, conflicts)
    }
}
