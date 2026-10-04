package com.memoking.app

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileNotFoundException

/**
 * "이 휴대폰에만 보관" 메모 폴더의 첨부를 다른 앱(사진·PDF 보기 등)이 열 수 있게 내어 주는 제공자.
 * 사용자가 고른 폴더(SAF)는 그 폴더의 문서 주소를 그대로 쓰므로 여기를 거치지 않는다.
 * content://com.memoking.app.files/<메모 폴더 기준 경로>
 */
class VaultFileProvider : ContentProvider() {
    companion object {
        const val AUTHORITY = "com.memoking.app.files"
        /** 보내기용 파일(그림·PDF): cache/share/ → content://com.memoking.app.files/~share/<이름> */
        const val SHARE_DIR = "share"
        private const val SHARE_PREFIX = "~share"

        fun shareUriFor(name: String): Uri = Uri.Builder().scheme("content").authority(AUTHORITY)
            .encodedPath("/$SHARE_PREFIX/" + Uri.encode(name)).build()

        fun uriFor(rel: String): Uri = Uri.Builder().scheme("content").authority(AUTHORITY)
            .encodedPath("/" + Storage.clean(rel).split('/').joinToString("/") { Uri.encode(it) })
            .build()

        fun mimeOf(name: String): String =
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
                ?: "application/octet-stream"
    }

    private fun fileFor(uri: Uri): File {
        val ctx: Context = context ?: throw FileNotFoundException()
        if (uri.pathSegments.firstOrNull() == SHARE_PREFIX && uri.pathSegments.size == 2) {
            val dir = File(ctx.cacheDir, SHARE_DIR).canonicalFile
            val file = File(dir, uri.pathSegments[1]).canonicalFile
            if (file.parentFile != dir) throw FileNotFoundException()
            return file
        }
        val root = Vaults.internalRoot(ctx).canonicalFile
        val rel = Storage.clean(uri.pathSegments.joinToString("/"))
        val file = File(root, rel).canonicalFile
        if (!file.path.startsWith(root.path + File.separator)) throw FileNotFoundException()
        return file
    }

    override fun onCreate() = true

    override fun getType(uri: Uri): String = mimeOf(uri.lastPathSegment ?: "")

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("읽기만 할 수 있어요")
        val file = fileFor(uri)
        if (!file.isFile) throw FileNotFoundException(uri.toString())
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val file = fileFor(uri)
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val cursor = MatrixCursor(cols)
        cursor.addRow(cols.map {
            when (it) {
                OpenableColumns.DISPLAY_NAME -> file.name
                OpenableColumns.SIZE -> file.length()
                else -> null
            }
        })
        return cursor
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
