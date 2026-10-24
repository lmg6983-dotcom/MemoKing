// 기본 모델 (설정 › AI 도우미 › 기본 모델 받기) — PC · 휴대폰이 함께.
//   Apache 2.0 이라 누구에게나 쓰게 할 수 있는 것으로 (카나나2 는 제3자용 온디바이스 제공에 카카오 별도 계약이 필요해 사용자가 직접 넣는 선택 모델).
//   앱에 넣으면 설치 파일 · 업데이트가 GB 단위로 커져서, 인터넷이 될 때 한 번 Hugging Face 에서 받는다. 그다음은 인터넷 없이
export const DEFAULT_MODEL = {
  role: 'chat',
  label: '젬마4 E2B',
  repo: 'unsloth/gemma-4-E2B-it-qat-GGUF', // 구글 QAT 체크포인트를 Unsloth 가 GGUF 로 — 같은 크기의 보통 4비트보다 품질 손실이 작다
  file: /UD-Q4_K_XL\.gguf$/i,
  approx: '약 2.6GB',
  license: 'Apache 2.0',
};

/** 휴대폰 기본 모델 — 같은 젬마4 E2B 를 구글 LiteRT-LM(GPU) 형식으로. llama.cpp(CPU)는 휴대폰에서 너무 느리다 (LocalAi.kt 의 LiteRtChat)
 *    revision: 앱의 LiteRT-LM 버전과 맞는 파일로 고정 (구글 AI Edge Gallery 가 같은 엔진 0.18.0 으로 쓰는 커밋 — 새 파일은 새 엔진에서만 열릴 수 있다) */
export const PHONE_MODEL = {
  ...DEFAULT_MODEL,
  repo: 'litert-community/gemma-4-E2B-it-litert-lm',
  revision: '7fa1d78473894f7e736a21d920c3aa80f950c0db',
  file: /^gemma-4-E2B-it\.litertlm$/,
};

/** 저장소의 파일 목록 (파일마다 크기 · SHA-256) */
export const modelInfoUrl = (m) => `https://huggingface.co/api/models/${m.repo}${m.revision ? `/revision/${m.revision}` : ''}?blobs=true`;

/** 목록 → 받을 것 { name, url, size, sha256 } — 보조 파일(mtp 초안 · mmproj 그림)은 빼고, 목록을 받은 그 커밋으로 고정 */
export function pickModelFile(m, info) {
  const f = (info?.siblings ?? []).find((s) => m.file.test(s.rfilename) && !/mtp|mmproj/i.test(s.rfilename));
  const sha256 = f?.lfs?.sha256 ?? '';
  if (!f || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('받을 모델 파일을 찾지 못했어요. 잠시 뒤 다시 해 주세요');
  const path = f.rfilename.split('/').map(encodeURIComponent).join('/');
  return { name: f.rfilename.split('/').pop(), url: `https://huggingface.co/${m.repo}/resolve/${info.sha ?? 'main'}/${path}`, size: f.lfs.size ?? f.size ?? 0, sha256 };
}
