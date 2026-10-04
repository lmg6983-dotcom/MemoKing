package com.memoking.app

/** sherpa-onnx 라이브러리 없이 빌드할 때 (android/scripts/fetch-sherpa-onnx.sh 를 먼저 실행하면 진짜가 들어간다) */
object ProEngine {
    const val AVAILABLE = false

    fun diarize(segmentation: String, embedding: String, samples: FloatArray, speakers: Int, onProgress: (Int) -> Unit): List<Seg> =
        throw IllegalStateException("이 빌드에는 말한 사람 구분이 들어 있지 않아요")

    fun whisper(encoder: String, decoder: String, tokens: String): ProRecognizer =
        throw IllegalStateException("이 빌드에는 정확한 받아쓰기가 들어 있지 않아요")
}
