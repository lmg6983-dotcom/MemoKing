package com.memoking.app.drive

import com.memoking.app.FileStorage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class SheetInboxTest {
    @Test
    fun `7열 구 헤더 시트에 8열 pending 행이 들어와도 자동 보정해 처리한다`() {
        val legacyCsv = listOf(
            "req_id,action,memo_id,folder,body,find,status",
            "20261125-01,create,,할일,# 기존 메모,,done (old-1)",
            "20261126-01,create,,AI 리포트(월드),green,# 새 리포트,,pending",
        ).joinToString("\r\n")

        assertTrue(SheetInbox.needsHeaderUpgrade(legacyCsv))
        val rows = SheetInbox.rowsFromCsv(legacyCsv)
        assertEquals(2, rows.size)
        assertEquals("done (old-1)", rows[0].status)
        assertEquals("green", rows[1].color)
        assertEquals("# 새 리포트", rows[1].body)
        assertEquals("pending", rows[1].status)

        val out = SheetInbox.runSheet(legacyCsv) { job, _ ->
            val create = job as SheetInbox.Job.Create
            assertEquals("green", create.color)
            assertEquals("AI 리포트(월드)", create.folder)
            SheetInbox.ApplyResult(id = "new-1")
        }
        assertNotNull(out)
        assertEquals(1, out!!.done)
        assertFalse(SheetInbox.needsHeaderUpgrade(out.csv))
        assertEquals("done (new-1)", SheetInbox.rowsFromCsv(out.csv)[1].status)
    }

    @Test
    fun `기기 충돌 사본은 inboxLeader 선출에서 제외된다`() {
        val now = 1_795_734_268_000L
        val me = "_memoking/기기/SM-F731N (9604).md"
        val conflict = "_memoking/기기/SM-F731N (9604) (휴대폰 충돌 2026-11-27 0134).md"
        val devices = listOf(
            SheetInbox.DeviceEntry(conflict, "phone", now - 10_000L),
            SheetInbox.DeviceEntry(me, "phone", now - 5_000L),
        )
        assertTrue(SheetInbox.isConflictDeviceFile(conflict))
        assertTrue(SheetInbox.inboxLeader(devices, me, "phone", now))
    }

    @Test
    fun `로컬 Storage 에 create append replace trash 를 적용하고 잠긴 메모를 보호한다`() {
        val dir = Files.createTempDirectory("memoking-sheet-test").toFile()
        try {
            val storage = FileStorage(dir, "test")
            val created = SheetInbox.applyJob(storage, SheetInbox.Job.Create("업무", "blue", "# 회의\n월요일"))
            assertNull(created.error)
            val id = created.id!!
            assertTrue(File(dir, "업무/회의.md").exists())
            assertTrue(File(dir, "업무/회의.md").readText().contains("color: blue"))

            val appended = SheetInbox.applyJob(storage, SheetInbox.Job.Append(id, "화요일"))
            assertNull(appended.error)
            assertTrue(File(dir, "업무/회의.md").readText().contains("월요일\n화요일"))

            val replaced = SheetInbox.applyJob(storage, SheetInbox.Job.Replace(id, "화요일", "수요일"))
            assertNull(replaced.error)
            assertTrue(File(dir, "업무/회의.md").readText().contains("수요일"))
            assertTrue(File(dir, "_memoking/versions/$id").listFiles()?.isNotEmpty() == true)

            val trashed = SheetInbox.applyJob(storage, SheetInbox.Job.Trash(id))
            assertNull(trashed.error)
            assertFalse(File(dir, "업무/회의.md").exists())
            assertTrue(File(dir, "_memoking/trash").listFiles()?.isNotEmpty() == true)

            File(dir, "비밀.md").writeText("---\nid: lk\n---\n# 비밀\n\n<!-- memoking-lock v1 -->\n")
            val lockedErr = SheetInbox.applyJob(storage, SheetInbox.Job.Append("lk", "몰래"))
            assertEquals("잠긴 메모는 고칠 수 없어요", lockedErr.error)
        } finally {
            dir.deleteRecursively()
        }
    }
}
