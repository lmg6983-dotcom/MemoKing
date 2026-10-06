package com.memoking.app

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.io.File
import java.io.FileNotFoundException
import java.io.InputStream
import java.io.OutputStream

/**
 * 메모 폴더(볼트) 안의 파일을 다루는 최소한의 파일 시스템.
 * 경로는 모두 메모 폴더 기준 상대 경로이고 "/" 로 나눈다 (예: "attachments/a.png").
 * 화면(웹) 쪽 vault.js 가 데스크탑 Vault 와 같은 규칙으로 이 위에서 동작한다.
 */
interface Storage {
    /** 화면에 보여 줄 폴더 이름 */
    val label: String

    /** 파일·폴더 정보 (없으면 null) */
    fun stat(rel: String): Entry?

    /** 폴더 안 목록 (폴더가 없으면 빈 목록) */
    fun list(rel: String): List<Entry>

    fun mkdirs(rel: String)
    fun openRead(rel: String): InputStream
    fun write(rel: String, write: (OutputStream) -> Unit): Entry

    /** 이름 바꾸기·다른 폴더로 옮기기. 도착 경로에 파일이 있으면 실패. */
    fun move(from: String, to: String): Boolean
    fun delete(rel: String): Boolean

    /** 다른 앱이 열 수 있는 주소 (파일 열기) */
    fun shareUri(rel: String): Uri?

    data class Entry(val name: String, val dir: Boolean, val mtime: Long, val size: Long)

    companion object {
        fun parent(rel: String): String = rel.substringBeforeLast('/', "")
        fun name(rel: String): String = rel.substringAfterLast('/')

        /** "../" 처럼 폴더 밖으로 나가는 경로는 거부한다 */
        fun clean(rel: String): String {
            val parts = rel.replace('\\', '/').split('/').filter { it.isNotEmpty() && it != "." }
            require(parts.none { it == ".." }) { "메모 폴더 밖 경로: $rel" }
            return parts.joinToString("/")
        }
    }
}

/** 앱 안 저장 공간 (이 휴대폰에만 보관) */
class FileStorage(private val root: File, override val label: String) : Storage {
    init {
        root.mkdirs()
    }

    private fun file(rel: String) = if (rel.isEmpty()) root else File(root, Storage.clean(rel))

    private fun entry(f: File) = Storage.Entry(f.name, f.isDirectory, f.lastModified(), if (f.isFile) f.length() else 0)

    override fun stat(rel: String): Storage.Entry? = file(rel).takeIf { it.exists() }?.let(::entry)

    override fun list(rel: String): List<Storage.Entry> = file(rel).listFiles()?.map(::entry) ?: emptyList()

    override fun mkdirs(rel: String) {
        file(rel).mkdirs()
    }

    override fun openRead(rel: String): InputStream = file(rel).inputStream()

    override fun write(rel: String, write: (OutputStream) -> Unit): Storage.Entry {
        val target = file(rel)
        target.parentFile?.mkdirs()
        // 임시 파일에 쓰고 바꿔치기 — 저장 도중 꺼져도 원본이 깨지지 않는다
        val tmp = File(target.parentFile, ".${target.name}.${System.nanoTime()}.tmp")
        tmp.outputStream().use(write)
        if (!tmp.renameTo(target)) {
            target.delete()
            if (!tmp.renameTo(target)) {
                tmp.delete()
                throw java.io.IOException("저장하지 못했어요: $rel")
            }
        }
        return entry(target)
    }

    override fun move(from: String, to: String): Boolean {
        val src = file(from)
        val dst = file(to)
        if (!src.exists() || dst.exists()) return false
        dst.parentFile?.mkdirs()
        return src.renameTo(dst)
    }

    override fun delete(rel: String): Boolean {
        val f = file(rel)
        return if (f.isDirectory) f.deleteRecursively() else f.delete()
    }

    override fun shareUri(rel: String): Uri? = stat(rel)?.let { VaultFileProvider.uriFor(rel) }
}

/**
 * 사용자가 고른 폴더 (저장소 접근 프레임워크, SAF).
 * 휴대폰 저장 공간의 아무 폴더나 고를 수 있고, 동기화 앱(FolderSync·Autosync 등)이 그 폴더를 PC 의 메모 폴더와 맞춘다.
 */
class SafStorage(context: Context, private val tree: Uri) : Storage {
    private val resolver: ContentResolver = context.contentResolver
    private val rootId: String = DocumentsContract.getTreeDocumentId(tree)
    private val ids = HashMap<String, String>() // 상대 경로 → 문서 id
    private val lock = Any()

    override val label: String = run {
        val id = Uri.decode(rootId)
        // "primary:Documents/메모킹" → "내장 저장공간/Documents/메모킹"
        val (volume, path) = if (':' in id) id.substringBefore(':') to id.substringAfter(':') else "" to id
        val head = when (volume) {
            "primary" -> "내장 저장공간"
            "" -> ""
            else -> volume
        }
        listOf(head, path).filter { it.isNotEmpty() }.joinToString("/")
    }

    private fun docUri(id: String): Uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)

    private val projection = arrayOf(
        Document.COLUMN_DOCUMENT_ID,
        Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_MIME_TYPE,
        Document.COLUMN_LAST_MODIFIED,
        Document.COLUMN_SIZE,
    )

    private data class Child(val id: String, val entry: Storage.Entry)

    private fun query(uri: Uri): List<Child> {
        val out = ArrayList<Child>()
        resolver.query(uri, projection, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val mime = c.getString(2) ?: ""
                out += Child(
                    c.getString(0),
                    Storage.Entry(
                        name = c.getString(1) ?: "",
                        dir = mime == Document.MIME_TYPE_DIR,
                        mtime = if (c.isNull(3)) 0 else c.getLong(3),
                        size = if (c.isNull(4)) 0 else c.getLong(4),
                    ),
                )
            }
        }
        return out
    }

    private fun children(dirId: String, dirRel: String): List<Child> {
        val list = query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, dirId))
        synchronized(lock) {
            for (child in list) ids[join(dirRel, child.entry.name)] = child.id
        }
        return list
    }

    private fun join(dir: String, name: String) = if (dir.isEmpty()) name else "$dir/$name"

    private fun forget(rel: String) = synchronized(lock) {
        ids.keys.removeAll { it == rel || it.startsWith("$rel/") }
    }

    /** 경로 → 문서 id. 기억해 둔 id 가 낡았으면(밖에서 지움) 다시 찾는다. */
    private fun resolve(rel: String, verify: Boolean = true): String? {
        val path = Storage.clean(rel)
        if (path.isEmpty()) return rootId
        synchronized(lock) { ids[path] }?.let { id ->
            if (!verify || exists(id)) return id
            forget(path)
        }
        var dirId = rootId
        var dirRel = ""
        for (part in path.split('/')) {
            val next = join(dirRel, part)
            val known = synchronized(lock) { ids[next] }
            val id = known ?: children(dirId, dirRel).firstOrNull { it.entry.name == part }?.id ?: return null
            dirId = id
            dirRel = next
        }
        return dirId
    }

    private fun exists(id: String): Boolean = try {
        query(docUri(id)).isNotEmpty()
    } catch (e: Exception) {
        false
    }

    override fun stat(rel: String): Storage.Entry? {
        val id = resolve(rel) ?: return null
        return try {
            query(docUri(id)).firstOrNull()?.entry
        } catch (e: Exception) {
            null
        }
    }

    override fun list(rel: String): List<Storage.Entry> {
        val path = Storage.clean(rel)
        val id = resolve(path) ?: return emptyList()
        return try {
            children(id, path).map { it.entry }
        } catch (e: Exception) {
            forget(path)
            emptyList()
        }
    }

    private fun ensureDir(rel: String): String {
        val path = Storage.clean(rel)
        resolve(path)?.let { return it }
        val parentId = ensureDir(Storage.parent(path))
        val uri = DocumentsContract.createDocument(resolver, docUri(parentId), Document.MIME_TYPE_DIR, Storage.name(path))
            ?: throw FileNotFoundException("폴더를 만들지 못했어요: $path")
        val id = DocumentsContract.getDocumentId(uri)
        synchronized(lock) { ids[path] = id }
        return id
    }

    override fun mkdirs(rel: String) {
        ensureDir(rel)
    }

    override fun openRead(rel: String): InputStream {
        val id = resolve(rel) ?: throw FileNotFoundException(rel)
        return resolver.openInputStream(docUri(id)) ?: throw FileNotFoundException(rel)
    }

    override fun write(rel: String, write: (OutputStream) -> Unit): Storage.Entry {
        val path = Storage.clean(rel)
        val id = resolve(path) ?: run {
            val parentId = ensureDir(Storage.parent(path))
            // octet-stream 으로 만들어야 제공자가 확장자를 덧붙이지 않는다 ("메모.md.txt" 방지)
            val uri = DocumentsContract.createDocument(resolver, docUri(parentId), "application/octet-stream", Storage.name(path))
                ?: throw FileNotFoundException("파일을 만들지 못했어요: $path")
            DocumentsContract.getDocumentId(uri).also { synchronized(lock) { ids[path] = it } }
        }
        val uri = docUri(id)
        val stream = try {
            resolver.openOutputStream(uri, "wt")
        } catch (e: Exception) {
            null // "wt"(덮어쓰며 비우기)를 모르는 제공자
        } ?: resolver.openOutputStream(uri, "w") ?: throw FileNotFoundException(path)
        stream.use(write)
        return query(uri).firstOrNull()?.entry ?: Storage.Entry(Storage.name(path), false, System.currentTimeMillis(), 0)
    }

    override fun move(from: String, to: String): Boolean {
        val src = Storage.clean(from)
        val dst = Storage.clean(to)
        val id = resolve(src) ?: return false
        if (resolve(dst) != null) return false
        val srcParent = Storage.parent(src)
        val dstParent = Storage.parent(dst)
        var uri = docUri(id)
        try {
            if (srcParent != dstParent) {
                val fromId = resolve(srcParent) ?: return false
                val toId = ensureDir(dstParent)
                uri = DocumentsContract.moveDocument(resolver, uri, docUri(fromId), docUri(toId)) ?: return copyMove(src, dst)
            }
            if (Storage.name(src) != Storage.name(dst)) {
                uri = DocumentsContract.renameDocument(resolver, uri, Storage.name(dst)) ?: return false
            }
        } catch (e: UnsupportedOperationException) {
            return copyMove(src, dst)
        } catch (e: IllegalStateException) {
            return copyMove(src, dst)
        }
        forget(src)
        forget(dst)
        synchronized(lock) { ids[dst] = DocumentsContract.getDocumentId(uri) }
        return true
    }

    // 옮기기를 지원하지 않는 제공자: 복사하고 원본 지우기
    private fun copyMove(src: String, dst: String): Boolean {
        if (stat(src)?.dir == true) return false
        openRead(src).use { input -> write(dst) { input.copyTo(it) } }
        return delete(src)
    }

    override fun delete(rel: String): Boolean {
        val path = Storage.clean(rel)
        val id = resolve(path) ?: return false
        return try {
            DocumentsContract.deleteDocument(resolver, docUri(id)).also { forget(path) }
        } catch (e: Exception) {
            false
        }
    }

    override fun shareUri(rel: String): Uri? = resolve(rel)?.let(::docUri)
}
