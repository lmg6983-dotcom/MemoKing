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
import com.memoking.app.drive.DriveSync
import java.io.File
import java.io.FileNotFoundException

/**
 * 앱 안 메모 폴더의 첨부를 다른 앱(사진·동영상·PDF 보기 등)이 열 수 있게 내어 주는 제공자.
 * 사용자가 고른 폴더(SAF)는 그 폴더의 문서 주소를 그대로 쓰므로 여기를 거치지 않는다.
 *   content://com.memoking.app.files/<메모 폴더 기준 경로>                  "이 휴대폰에만 보관"
 *   content://com.memoking.app.files/~drive/<Drive 폴더 id>/<경로>         Google Drive 폴더의 휴대폰 쪽 사본
 */
class VaultFileProvider : ContentProvider() {
    companion object {
        const val AUTHORITY = "com.memoking.app.files"
        /** 보내기용 파일(그림·PDF): cache/share/ → content://com.memoking.app.files/~share/<이름> */
        const val SHARE_DIR = "share"
        private const val SHARE_PREFIX = "~share"
        private const val DRIVE_PREFIX = "~drive"
        /** 받은 업데이트 APK: cache/updates/ → content://com.memoking.app.files/~update/<이름> (안드로이드 설치기가 읽는다) */
        private const val UPDATE_PREFIX = "~update"

        /** Google Drive 폴더 사본의 주소 앞부분 (FileStorage 의 shareRoot) */
        fun driveRoot(folderId: String) = "$DRIVE_PREFIX/" + Uri.encode(folderId)

        fun shareUriFor(name: String): Uri = Uri.Builder().scheme("content").authority(AUTHORITY)
            .encodedPath("/$SHARE_PREFIX/" + Uri.encode(name)).build()

        fun updateUriFor(name: String): Uri = Uri.Builder().scheme("content").authority(AUTHORITY)
            .encodedPath("/$UPDATE_PREFIX/" + Uri.encode(name)).build()

        fun uriFor(rel: String, root: String = ""): Uri = Uri.Builder().scheme("content").authority(AUTHORITY)
            .encodedPath("/" + (if (root.isEmpty()) "" else "$root/") + Storage.clean(rel).split('/').joinToString("/") { Uri.encode(it) })
            .build()

        fun mimeOf(name: String): String =
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
                ?: "application/octet-stream"
    }

    private fun fileFor(uri: Uri): File {
        val ctx: Context = context ?: throw FileNotFoundException()
        val flat = mapOf(SHARE_PREFIX to SHARE_DIR, UPDATE_PREFIX to AppUpdate.DIR)[uri.pathSegments.firstOrNull()]
        if (flat != null && uri.pathSegments.size == 2) {
            val dir = File(ctx.cacheDir, flat).canonicalFile
            val file = File(dir, uri.pathSegments[1]).canonicalFile
            if (file.parentFile != dir) throw FileNotFoundException()
            return file
        }
        val segments = uri.pathSegments
        // Drive 폴더 사본: 예전엔 늘 "이 휴대폰에만" 폴더에서 찾아서, Drive 를 쓰면 다른 앱으로 열기가 늘 실패했다
        val drive = segments.firstOrNull() == DRIVE_PREFIX && segments.size >= 3
        val sandbox = segments.firstOrNull() == Vaults.SANDBOX_SHARE && segments.size >= 2 // 튜토리얼 연습 공간
        val root = (if (drive) DriveSync.mirrorDir(ctx, segments[1]) else if (sandbox) Vaults.sandboxRoot(ctx) else Vaults.internalRoot(ctx)).canonicalFile
        if (drive && root.parentFile != File(ctx.filesDir, "drive").canonicalFile) throw FileNotFoundException()
        val rel = Storage.clean((if (drive) segments.drop(2) else if (sandbox) segments.drop(1) else segments).joinToString("/"))
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
