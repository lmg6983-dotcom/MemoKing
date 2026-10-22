package com.memoking.app.drive

import com.memoking.app.FileStorage
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

/** 동기화 엔진: 가짜 Google Drive + 실제 파일 폴더로 PC·휴대폰 사이 상황을 차례로 확인한다 */
class SyncEngineTest {
    class FakeDrive : Remote {
        data class F(val id: String, var name: String, var parent: String, val folder: Boolean, var data: ByteArray = ByteArray(0), var modified: Long = 0, var trashed: Boolean = false)
        val files = LinkedHashMap<String, F>()
        var seq = 0
        var changed = true
        var calls = 0
        init { files["ROOT"] = F("ROOT", "메모킹", "", true) }
        fun md5(b: ByteArray) = MessageDigest.getInstance("MD5").digest(b).joinToString("") { "%02x".format(it) }
        fun item(f: F) = Remote.Item(f.id, f.name, f.folder, if (f.folder) null else md5(f.data), f.modified, f.data.size.toLong())
        fun path(rel: String): F? {
            var cur = "ROOT"
            for (p in rel.split('/')) cur = files.values.firstOrNull { it.parent == cur && it.name == p && !it.trashed }?.id ?: return null
            return files[cur]
        }
        fun put(rel: String, text: String) {
            var cur = "ROOT"
            val parts = rel.split('/')
            for (p in parts.dropLast(1)) cur = (files.values.firstOrNull { it.parent == cur && it.name == p && !it.trashed } ?: createFolder(cur, p).let { files[it.id]!! }).id
            val f = path(rel) ?: F("f${++seq}", parts.last(), cur, false).also { files[it.id] = it }
            f.data = text.toByteArray(); f.modified = System.currentTimeMillis(); changed = true
        }
        fun text(rel: String) = path(rel)?.data?.toString(Charsets.UTF_8)
        override fun listChildren(folderId: String) = files.values.filter { it.parent == folderId && !it.trashed }.map(::item).also { calls++ }
        override fun download(id: String, out: OutputStream) { out.write(files[id]!!.data) }
        override fun upload(parentId: String, name: String, existingId: String?, size: Long, open: () -> InputStream): Remote.Item {
            val f = existingId?.let { files[it] } ?: F("f${++seq}", name, parentId, false).also { files[it.id] = it }
            f.data = open().use { it.readBytes() }; f.modified = System.currentTimeMillis()
            return item(f)
        }
        override fun createFolder(parentId: String, name: String): Remote.Item { val f = F("d${++seq}", name, parentId, true); files[f.id] = f; return item(f) }
        override fun trash(id: String) { files[id]!!.trashed = true }
        override fun changesSince(token: String?, knownIds: Set<String>): Pair<Boolean, String> { val c = changed || token == null; changed = false; return c to "t" }
    }

    private val dir = File(System.getProperty("java.io.tmpdir"), "synctest-${System.nanoTime()}")
    private val local = FileStorage(dir, "t")
    private val drive = FakeDrive()
    private val state = JSONObject()

    private fun sync() = SyncEngine(local, drive, "ROOT", state).run()
    private fun lt(rel: String) = File(dir, rel).takeIf { it.exists() }?.readText()
    private fun lw(rel: String, t: String) {
        Thread.sleep(5) // 파일 시각이 달라지게
        local.write(rel) { it.write(t.toByteArray()) }
    }

    @After
    fun cleanup() {
        dir.deleteRecursively()
    }

    // PC 에서 만든 메모들이 Drive 에 있는 상태로 시작
    private fun startFromPc() {
        drive.put("회의.md", "# 회의\n내용")
        drive.put("attachments/a.png", "PNG")
        drive.put("_memoking/index.json", "{pc}")
        drive.put("_memoking/README.md", "guide")
        val r = sync()
        assertEquals(3, r.downloaded)
    }

    @Test
    fun firstSyncDownloadsEverythingButIndex() {
        startFromPc()
        assertEquals("# 회의\n내용", lt("회의.md"))
        assertEquals("PNG", lt("attachments/a.png"))
        assertNull("index.json 은 기기마다 따로", lt("_memoking/index.json"))
        assertTrue("바뀐 것 없으면 건너뜀", sync().skipped)
    }

    @Test
    fun filesMissedByChangeFeedComeDownOnFullScan() {
        // 다른 앱(제미나이 등)이 넣은 파일을 Drive 의 "바뀐 것" 목록이 빠뜨려도 "지금 동기화" · 15분마다 처음부터 훑어 내려받는다
        var now = 1_800_000_000_000L
        fun run(full: Boolean = false) = SyncEngine(local, drive, "ROOT", state) { now }.run(full)
        drive.put("회의.md", "# 회의")
        run()
        drive.put("제미나이 메모.md", "# 제미나이")
        drive.changed = false
        now += 60_000
        assertTrue("목록만 보면 놓친다", run().skipped)
        assertNull(lt("제미나이 메모.md"))
        assertEquals("지금 동기화", 1, run(full = true).downloaded)
        assertEquals("# 제미나이", lt("제미나이 메모.md"))
        drive.put("또.md", "# 또")
        drive.changed = false
        now += 60_000
        assertTrue(run().skipped)
        now += SyncEngine.FULL_SCAN_MS
        assertEquals("15분마다", 1, run().downloaded)
    }

    @Test
    fun phoneChangesGoUp() {
        startFromPc()
        lw("휴대폰.md", "# 휴대폰")
        lw("회의.md", "# 회의\n휴대폰에서 고침")
        lw("_memoking/index.json", "{phone}")
        val r = sync()
        assertEquals(2, r.uploaded)
        assertEquals("# 휴대폰", drive.text("휴대폰.md"))
        assertEquals("# 회의\n휴대폰에서 고침", drive.text("회의.md"))
        assertEquals("{pc}", drive.text("_memoking/index.json"))
        lw("업무/계획.md", "plan")
        sync()
        assertEquals("새 하위 폴더도 만들어 올림", "plan", drive.text("업무/계획.md"))
    }

    @Test
    fun pcChangesComeDown() {
        startFromPc()
        drive.put("회의.md", "# 회의\nPC에서 고침")
        val r = sync()
        assertTrue(r.localChanged)
        assertEquals("# 회의\nPC에서 고침", lt("회의.md"))
    }

    @Test
    fun bothChangedKeepsPcAndCopiesPhone() {
        startFromPc()
        drive.put("회의.md", "# 회의\nPC 버전")
        lw("회의.md", "# 회의\n휴대폰 버전")
        val r = sync()
        assertEquals("# 회의\nPC 버전", lt("회의.md"))
        val copy = dir.listFiles()!!.map { it.name }.firstOrNull { it.startsWith("회의 (휴대폰 충돌") }
        assertNotNull(copy)
        assertEquals("# 회의\n휴대폰 버전", lt(copy!!))
        assertEquals("# 회의\n휴대폰 버전", drive.text(copy))
        assertEquals(1, r.conflicts.size)

        drive.put("같음.md", "same")
        lw("같음.md", "same")
        assertTrue("양쪽 같은 내용은 충돌 아님", sync().conflicts.isEmpty())
    }

    @Test
    fun deletionsPropagate() {
        startFromPc()
        lw("휴대폰.md", "# 휴대폰")
        sync()
        local.delete("휴대폰.md")
        assertEquals(1, sync().deletedRemote)
        assertNull("휴대폰에서 삭제하면 Drive 휴지통으로", drive.path("휴대폰.md"))

        // PC 에서 메모를 휴지통으로 옮김 (_memoking/trash 로 이름 바뀜)
        val f = drive.path("회의.md")!!
        drive.put("_memoking/trash/회의 (20261003-120000).md", "# 회의\n내용")
        f.trashed = true
        drive.changed = true
        sync()
        assertNull(lt("회의.md"))
        assertEquals("# 회의\n내용", lt("_memoking/trash/회의 (20261003-120000).md"))
    }

    @Test
    fun linkPreviewsMerge() {
        startFromPc()
        drive.put("_memoking/link-previews.json", "{\"a\":1}")
        sync()
        drive.put("_memoking/link-previews.json", "{\"a\":1,\"pc\":2}")
        lw("_memoking/link-previews.json", "{\"a\":1,\"phone\":3}")
        sync()
        val merged = JSONObject(lt("_memoking/link-previews.json")!!)
        assertTrue(merged.has("pc") && merged.has("phone"))
        assertTrue(JSONObject(drive.text("_memoking/link-previews.json")!!).has("phone"))
    }

    @Test
    fun massDisappearanceStops() {
        startFromPc()
        for (i in 1..30) lw("많은/$i.md", "x$i")
        sync()
        drive.files.values.filter { !it.folder }.forEach { it.trashed = true }
        drive.changed = true
        val stopped = try {
            sync()
            false
        } catch (e: SyncEngine.SafetyStop) {
            true
        }
        assertTrue(stopped)
        assertEquals("휴대폰 파일은 그대로", "x1", lt("많은/1.md"))
    }
}
