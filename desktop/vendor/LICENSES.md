# PC 받아쓰기 · 로컬 AI 에 쓰는 오픈소스

| 이름 | 쓰는 곳 | 라이선스 |
|---|---|---|
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 1.13.8 (WebAssembly, Node 판) | `sherpa-onnx/` — 받아쓰기·말소리 구간·말한 사람 나누기 엔진 | Apache-2.0 (`sherpa-onnx/LICENSE`) |
| [seek-bzip](https://github.com/cscott/seek-bzip) 2.0.0 | `seek-bzip/` — 받은 모델 압축(.tar.bz2) 풀기 (`Buffer.allocUnsafe` 로만 고침) | MIT (`seek-bzip/LICENSE`) |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) b11400 (Windows Vulkan 빌드의 `llama-server.exe` · DLL) | `llama/` — 로컬 AI 엔진. `npm run llama` 로 받아 설치 파일에 넣음 (git 에는 없음) | MIT |

처음 쓸 때 받는 데이터 (앱에 들어 있지 않음, 이 PC 의 앱 데이터 폴더 `stt\` 에 저장):

| 데이터 | 받는 곳 | 라이선스 |
|---|---|---|
| 한국어 Zipformer (KsponSpeech, `sherpa-onnx-zipformer-korean-2024-06-24`, int8) | Hugging Face `k2-fsa/…` 또는 k2-fsa/sherpa-onnx 릴리스 | Apache-2.0 |
| Silero VAD | k2-fsa/sherpa-onnx 릴리스 `asr-models/silero_vad.onnx` | MIT |
| pyannote segmentation 3.0 (int8) | k2-fsa/sherpa-onnx 릴리스 `speaker-segmentation-models` | MIT |
| 3D-Speaker CAM++ (`3dspeaker_speech_campplus_sv_zh-cn_16k-common`) | k2-fsa/sherpa-onnx 릴리스 `speaker-recongition-models` | Apache-2.0 |

로컬 AI 모델(.gguf)은 앱에 들어 있지 않아요. 사용자가 설정 › AI 도우미에서 넣고, 이 PC 의 앱 데이터 폴더 `ai\` 에 복사돼요.
