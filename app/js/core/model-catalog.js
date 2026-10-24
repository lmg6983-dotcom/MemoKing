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

// AI 글 도우미 모델 (PC 설정 › AI 글 도우미 › 받기) — PC 에만. 카카오 카나나2 (한국어로 학습, kanana-open-license, Powered by Kanana)
//   .github/workflows/kanana-gguf.yml 이 llama.cpp 용 GGUF 로 바꾸고 한국어 글로 잰 중요도(imatrix)로 양자화한 것.
//   앱에 넣으면 설치 파일이 GB 단위로 커져서, 인터넷이 될 때 한 번 받는다. 그다음은 인터넷 없이. 크기 · SHA-256 이 맞아야 넣는다
const KANANA = 'https://github.com/lmg6983-dotcom/memoking-releases/releases/download/kanana-2-gguf-1/';
export const WRITE_MODELS = [
  { id: '1.3b', label: '카나나2 1.3B', note: '가볍고 빨라요', minRamGB: 0, license: 'Kanana 오픈 라이선스', url: `${KANANA}kanana-2-1.3b-instruct-Q4_K_M.gguf`, size: 0, sha256: '' },
  { id: '3b', label: '카나나2 3B', note: '더 정확해요', minRamGB: 12, license: 'Kanana 오픈 라이선스', url: `${KANANA}kanana-2-3b-instruct-Q4_K_M.gguf`, size: 0, sha256: '' },
];

/** 이 PC 에 알맞은 모델 — 메모리(GB)가 넉넉하면 큰 것 (8GB PC 는 1.3B: 윈도 · 브라우저와 함께 돌려도 버벅이지 않게) */
export const recommendModel = (ramBytes) => WRITE_MODELS.findLast((m) => ramBytes / 2 ** 30 >= m.minRamGB) ?? WRITE_MODELS[0];

/** 화면에 쓸 크기 "약 0.8GB" */
export const approxSize = (m) => `약 ${(m.size / 2 ** 30).toFixed(1)}GB`;
