// AI 태그 모델 (설정 › AI 태그 › 받기) — PC · 휴대폰이 같은 파일.
//   Laya 한국어 (2nugu/laya-ko, Apache 2.0 — Laya 다국어를 한국어 KLUE · AI-Hub 로 더 학습시킨 것)를
//   .github/workflows/laya-model.yml 이 ONNX 로 바꾸고 encoder 를 8비트로 줄인 것. 한 번 받으면 인터넷 없이.
//   파일마다 크기 · SHA-256 이 맞아야 넣는다 (만들 때마다 encoder 가 조금 달라서 올린 그 파일로 고정)
export const LAYA_MODEL = {
  label: 'Laya 한국어',
  approx: '약 390MB',
  license: 'Apache 2.0',
  base: 'https://github.com/lmg6983-dotcom/memoking-releases/releases/download/laya-ko-int8-1/',
  files: [ // laya-model.yml 실행 40064852464 의 Artifacts: laya-ko-int8
    { name: 'encoder.onnx', size: 309462936, sha256: 'b4efd92985d3c9712398b794c37148225cb4ae827252b55f1f57a387dba16e40' },
    { name: 'head.onnx', size: 228564, sha256: '86162855ae01795e86cf0c59864563f8a004161340ad0f8d0ff9bfe79373aa81' },
    { name: 'head.onnx.data', size: 59877376, sha256: '5288ee94cd3c1b65ad1de4260f31bfd77237f837f92318c7470258c2c24386bc' },
    { name: 'tokenizer.json', size: 34363188, sha256: '609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f' },
    { name: 'rl_agent_config.json', size: 1402, sha256: 'f7eb0277c898078c431c73250cb3000279b5884f3835344ecd8aa1f14bec48c4' },
  ],
};

// AI 글 도우미 기본 모델 (PC 설정 › AI 글 도우미 › 기본 모델 받기) — PC 에만.
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

/** 저장소의 파일 목록 (파일마다 크기 · SHA-256) */
export const modelInfoUrl = (m) => `https://huggingface.co/api/models/${m.repo}?blobs=true`;

/** 목록 → 받을 것 { name, url, size, sha256 } — 보조 파일(mtp 초안 · mmproj 그림)은 빼고, 목록을 받은 그 커밋으로 고정 */
export function pickModelFile(m, info) {
  const f = (info?.siblings ?? []).find((s) => m.file.test(s.rfilename) && !/mtp|mmproj/i.test(s.rfilename));
  const sha256 = f?.lfs?.sha256 ?? '';
  if (!f || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('받을 모델 파일을 찾지 못했어요. 잠시 뒤 다시 해 주세요');
  const path = f.rfilename.split('/').map(encodeURIComponent).join('/');
  return { name: f.rfilename.split('/').pop(), url: `https://huggingface.co/${m.repo}/resolve/${info.sha ?? 'main'}/${path}`, size: f.lfs.size ?? f.size ?? 0, sha256 };
}
