package com.memoking.app

import com.k2fsa.sherpa.onnx.FastClusteringConfig
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarization
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarizationConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerSegmentationModelConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerSegmentationPyannoteModelConfig
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig

/** sherpa-onnx (k2-fsa/sherpa-onnx, Apache-2.0) 를 부르는 곳 — 라이브러리(app/libs/sherpa-onnx.aar)가 있을 때만 빌드에 들어간다 */
object ProEngine {
    const val AVAILABLE = true

    private val threads = (Runtime.getRuntime().availableProcessors() / 2).coerceIn(1, 4)

    /** 말한 사람 구분: 구간(초)과 사람 번호. speakers = 0 이면 사람 수를 저절로 */
    fun diarize(segmentation: String, embedding: String, samples: FloatArray, speakers: Int, onProgress: (Int) -> Unit): List<Seg> {
        val config = OfflineSpeakerDiarizationConfig(
            segmentation = OfflineSpeakerSegmentationModelConfig(
                pyannote = OfflineSpeakerSegmentationPyannoteModelConfig(model = segmentation),
                numThreads = threads,
            ),
            embedding = SpeakerEmbeddingExtractorConfig(model = embedding, numThreads = threads),
            clustering = FastClusteringConfig(numClusters = if (speakers > 0) speakers else -1, threshold = 0.5f),
            minDurationOn = 0.3f,
            minDurationOff = 0.5f,
        )
        val sd = OfflineSpeakerDiarization(config = config)
        try {
            val segs = sd.processWithCallback(samples, { done: Int, total: Int, _: Long ->
                if (total > 0) onProgress(done * 100 / total)
                0
            }, 0L)
            return segs.map { Seg(it.start, it.end, it.speaker) }
        } finally {
            sd.release()
        }
    }

    /** Whisper (OpenAI, MIT) — 한국어로 받아쓰기 */
    fun whisper(encoder: String, decoder: String, tokens: String): ProRecognizer {
        val config = OfflineRecognizerConfig(
            featConfig = FeatureConfig(sampleRate = Stt.SAMPLE_RATE, featureDim = 80),
            modelConfig = OfflineModelConfig(
                whisper = OfflineWhisperModelConfig(encoder = encoder, decoder = decoder, language = "ko", task = "transcribe"),
                tokens = tokens,
                numThreads = threads,
                // modelType 은 비워 둔다 — sherpa-onnx 가 whisper 설정을 보고 알아서 고른다
            ),
            decodingMethod = "greedy_search",
        )
        val recognizer = OfflineRecognizer(config = config)
        return object : ProRecognizer {
            override fun transcribe(samples: FloatArray): String {
                val stream = recognizer.createStream()
                try {
                    stream.acceptWaveform(samples, Stt.SAMPLE_RATE)
                    recognizer.decode(stream)
                    return recognizer.getResult(stream).text
                } finally {
                    stream.release()
                }
            }

            override fun release() = recognizer.release()
        }
    }
}
