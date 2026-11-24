package com.memoking.app.drive

import com.memoking.app.FileStorage
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

/**
 * PC 동기화 엔진(Rust drive_sync.rs)의 시험 자료 desktop-rs/core/tests/fixtures/drive_sync.json 을 휴대폰 엔진에도 돌린다 —
 *   두 엔진이 같은 상황에서 같은 끝 모습(양쪽 메모 · 올린 수 · 내려받은 수 · 지운 수 · 멈춤)이 되는지.
 *   다른 점은 일부러 둔 것만 맞춰 본다: 충돌 사본 이름(PC 충돌 ↔ 휴대폰 충돌), 기기마다 따로 두는 파일, 휴대폰에 없는 PC 만의 선택(localClean)
 */
class SharedFixturesTest {
    /** desktop-rs/core/tests/parity.rs 의 Fake 와 같은 가짜 Drive (id 를 "x:경로" · "d:경로" 로) */
    class Fake(remote: JSONObject, private val raw: JSONArray?, private val now: Long) : Remote {
        class It(val id: String, var name: String, val parent: String?, val folder: Boolean, var data: ByteArray = ByteArray(0), val gdoc: Boolean = false, var modified: Long = 0, var trashed: Boolean = false)
        val items = mutableListOf(It("root0", "", null, true))

        init {
            for (p in remote.keys().asSequence().toList()) {
                val v = remote.get(p)
                val o = if (v is String) JSONObject().put("text", v) else v as JSONObject
                val parts = p.trimEnd('/').split('/')
                var parent = "root0"
                for (i in 0 until parts.size - (if (p.endsWith('/')) 0 else 1)) parent = folder(parent, parts.subList(0, i + 1).joinToString("/"), parts[i])
                if (p.endsWith('/')) continue
                items += It(o.optString("id").ifEmpty { "x:$p" }, o.optString("name").ifEmpty { parts.last() }, parent, false, o.optString("text").toByteArray(), o.optBoolean("gdoc"), o.optLong("modified"))
            }
        }

        private fun folder(parent: String, rel: String, name: String): String {
            val id = "d:$rel"
            if (items.none { it.id == id }) items += It(id, name, parent, true)
            return id
        }

        private fun pathOf(id: String): String {
            val it = items.first { x -> x.id == id }
            return it.parent?.let { p -> pathOf(p).let { if (it.isEmpty()) it else "$it/" } + it.name } ?: ""
        }

        private fun md5(b: ByteArray) = MessageDigest.getInstance("MD5").digest(b).joinToString("") { "%02x".format(it) }
        private fun out(it: It) = Remote.Item(it.id, it.name, it.folder, if (it.folder || it.gdoc) null else md5(it.data), it.modified, it.data.size.toLong())

        @Synchronized override fun listChildren(folderId: String) = items.filter { it.parent == folderId && !it.trashed }.map(::out)
        @Synchronized override fun download(id: String, out: OutputStream) = out.write(items.first { it.id == id }.data)
        @Synchronized override fun upload(parentId: String, name: String, existingId: String?, size: Long, open: () -> InputStream): Remote.Item {
            val data = open().use { it.readBytes() }
            val it = existingId?.let { id -> items.first { it.id == id } }?.also { it.data = data; it.modified = now }
                ?: run {
                    var id = "x:" + pathOf(parentId).let { if (it.isEmpty()) name else "$it/$name" }
                    while (items.any { it.id == id }) id += "+"
                    It(id, name, parentId, false, data, modified = now).also { items += it }
                }
            return out(it)
        }
        @Synchronized override fun createFolder(parentId: String, name: String): Remote.Item {
            val id = folder(parentId, pathOf(parentId).let { if (it.isEmpty()) name else "$it/$name" }, name)
            return out(items.first { it.id == id })
        }
        @Synchronized override fun trash(id: String) { items.first { it.id == id }.trashed = true }

        // Rust drive_sync::pick_changes 와 같게: 아는 폴더 안의 것만 (새 폴더 안의 것도)
        @Synchronized override fun changesSince(token: String?, knownIds: Set<String>): Remote.Changes {
            if (token == null || raw == null) return Remote.Changes(true, "t1")
            val all = (0 until raw.length()).map { raw.getJSONObject(it) }
            fun parents(c: JSONObject) = c.optJSONObject("file")?.optJSONArray("parents")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
            val known = knownIds.toMutableSet()
            var grew = true
            while (grew) {
                grew = false
                for (c in all.filter { it.optJSONObject("file")?.optString("mimeType") == "application/vnd.google-apps.folder" }) {
                    if (c.getString("fileId") in known || parents(c).none { it in known }) continue
                    known += c.getString("fileId"); grew = true
                }
            }
            val picked = all.filter { c -> c.getString("fileId") in known || parents(c).any { it in known } }.map { c ->
                val f = c.optJSONObject("file")
                val item = f?.let { Remote.Item(c.getString("fileId"), it.optString("name"), it.optString("mimeType") == "application/vnd.google-apps.folder", it.optString("md5Checksum").ifEmpty { null }, 0, it.optString("size").toLongOrNull() ?: 0) }
                Remote.Change(c.getString("fileId"), c.optBoolean("removed") || f?.optBoolean("trashed") == true, parents(c), item)
            }
            return Remote.Changes(picked.isNotEmpty(), "t2", picked)
        }

        /** 지금 Drive 에 있는 파일 (경로 → 글) — 같은 이름이 둘이면 나중에 고친 것 (org.json 은 자료의 차례를 지키지 않아 Rust 처럼 "나중에 넣은 것" 으로 못 고른다) */
        fun live(): Map<String, String> = items.filter { !it.folder && !it.trashed }.sortedBy { it.modified }.associate { pathOf(it.id) to it.data.toString(Charsets.UTF_8) }
    }

    private fun fixtures(): JSONArray {
        var d: File? = File("").absoluteFile
        while (d != null && !File(d, "desktop-rs").isDirectory) d = d.parentFile
        return JSONArray(File(d, "desktop-rs/core/tests/fixtures/drive_sync.json").readText())
    }

    private fun walk(dir: File, rel: String = ""): Map<String, String> = (dir.listFiles() ?: emptyArray()).flatMap { f ->
        val r = if (rel.isEmpty()) f.name else "$rel/${f.name}"
        if (f.isDirectory) walk(f, r).entries.map { it.toPair() } else listOf(r to f.readText())
    }.toMap()

    // 메모 · 첨부만 견준다 (충돌 사본은 기기 이름만 다르게)
    private fun memos(m: Map<String, String>) = m.filterKeys { it.endsWith(".md") && !it.startsWith("_memoking/") }.mapKeys { it.key.replace(Regex(" \\((PC|휴대폰) 충돌 [^)]*\\)"), " (충돌)") }.toSortedMap()

    @Test
    fun sameOutcomeAsPcEngine() {
        val cases = fixtures()
        val fails = mutableListOf<String>()
        var ran = 0
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            if (c.getJSONObject("opts").optBoolean("localClean")) continue // PC 만의 선택 (휴대폰은 늘 메모 폴더를 훑는다)
            ran++
            val dir = File(System.getProperty("java.io.tmpdir"), "shared-${System.nanoTime()}").apply { mkdirs() }
            try {
                val local = c.getJSONObject("local")
                for (rel in local.keys()) {
                    val f = File(dir, rel)
                    if (rel.endsWith('/')) { f.mkdirs(); continue }
                    val v = local.get(rel)
                    f.parentFile.mkdirs()
                    f.writeText(if (v is JSONArray) v.getString(0) else v as String)
                    f.setLastModified(if (v is JSONArray) v.getLong(1) else c.getLong("mtime"))
                }
                val now = c.getLong("now")
                val fake = Fake(c.getJSONObject("remote"), c.optJSONArray("raw"), now)
                val state = JSONObject(c.getJSONObject("state").toString())
                val want = c.getJSONObject("out")
                val wantResult = want.getJSONObject("result")
                val got = try {
                    val r = SyncEngine(FileStorage(dir, "t"), fake, "root0", state) { now }.run(c.getJSONObject("opts").optBoolean("full"))
                    "올림 ${r.uploaded} · 받음 ${r.downloaded} · 여기서 지움 ${r.deletedLocal} · Drive 에서 지움 ${r.deletedRemote} · 건너뜀 ${r.skipped}"
                } catch (e: Exception) {
                    "멈춤"
                }
                val expect = if (wantResult.has("error")) "멈춤"
                else "올림 ${wantResult.getInt("uploaded")} · 받음 ${wantResult.getInt("downloaded")} · 여기서 지움 ${wantResult.getInt("deletedLocal")} · Drive 에서 지움 ${wantResult.getInt("deletedRemote")} · 건너뜀 ${wantResult.getBoolean("skipped")}"
                val wantLocal = want.getJSONObject("local").let { o -> o.keys().asSequence().filter { !it.endsWith('/') }.associateWith { o.getString(it) } }
                val wantRemote = want.getJSONObject("remote").getJSONObject("live").let { o -> o.keys().asSequence().filter { !it.endsWith('/') }.associateWith { o.getString(it) } }
                val diff = listOfNotNull(
                    (got != expect).takeIf { it }?.let { "결과  PC: $expect\n        휴대폰: $got" },
                    (memos(walk(dir)) != memos(wantLocal)).takeIf { it }?.let { "기기  PC: ${memos(wantLocal)}\n        휴대폰: ${memos(walk(dir))}" },
                    (memos(fake.live()) != memos(wantRemote)).takeIf { it }?.let { "Drive PC: ${memos(wantRemote)}\n        휴대폰: ${memos(fake.live())}" },
                )
                if (diff.isNotEmpty()) fails += "${c.getString("name")}\n  " + diff.joinToString("\n  ")
            } finally {
                dir.deleteRecursively()
            }
        }
        assertEquals("PC 엔진과 다른 끝 모습 ($ran 가지 가운데):\n" + fails.joinToString("\n"), 0, fails.size)
    }
}
