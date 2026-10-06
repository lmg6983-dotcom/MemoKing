package android.print

import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import java.io.File

/**
 * 인쇄 화면을 띄우지 않고 WebView 의 인쇄 내용(@media print)을 PDF 파일로 쓴다 (메모를 PDF 로 보내기).
 * LayoutResultCallback · WriteResultCallback 의 생성자가 SDK 에서 숨겨져 있어 같은 패키지(android.print)에 둔다.
 * 화면 스레드에서 불러야 한다. done(null) = 성공
 */
class PdfPrint(private val attributes: PrintAttributes) {
    fun write(adapter: PrintDocumentAdapter, file: File, done: (Throwable?) -> Unit) {
        adapter.onStart()
        adapter.onLayout(null, attributes, null, object : PrintDocumentAdapter.LayoutResultCallback() {
            override fun onLayoutFinished(info: PrintDocumentInfo, changed: Boolean) {
                val pfd = try {
                    ParcelFileDescriptor.open(
                        file,
                        ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE or ParcelFileDescriptor.MODE_READ_WRITE,
                    )
                } catch (e: Exception) {
                    done(e)
                    return
                }
                adapter.onWrite(arrayOf(PageRange.ALL_PAGES), pfd, CancellationSignal(), object : PrintDocumentAdapter.WriteResultCallback() {
                    override fun onWriteFinished(pages: Array<PageRange>) {
                        pfd.close()
                        adapter.onFinish()
                        done(null)
                    }

                    override fun onWriteFailed(error: CharSequence?) {
                        pfd.close()
                        adapter.onFinish()
                        done(IllegalStateException(error?.toString() ?: "PDF 쓰기 실패"))
                    }

                    override fun onWriteCancelled() {
                        pfd.close()
                        adapter.onFinish()
                        done(IllegalStateException("취소됨"))
                    }
                })
            }

            override fun onLayoutFailed(error: CharSequence?) {
                adapter.onFinish()
                done(IllegalStateException(error?.toString() ?: "PDF 배치 실패"))
            }

            override fun onLayoutCancelled() {
                adapter.onFinish()
                done(IllegalStateException("취소됨"))
            }
        }, null)
    }
}
