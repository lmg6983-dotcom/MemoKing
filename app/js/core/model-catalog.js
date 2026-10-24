// AI 태그 모델 (설정 › AI 태그 › 받기) — PC · 휴대폰이 같은 파일.
//   Laya 다국어 (convaiinnovations/laya-multilingual, Apache 2.0) 를 .github/workflows/laya-model.yml 이
//   ONNX 로 바꾸고 8비트로 줄인 것. 한 번 받으면 인터넷 없이. 파일마다 크기 · SHA-256 이 맞아야 넣는다
export const LAYA_MODEL = {
  label: 'Laya 다국어',
  approx: '약 390MB',
  license: 'Apache 2.0',
  base: 'https://github.com/lmg6983-dotcom/memoking-releases/releases/download/laya-multilingual-e4e9ddf/',
  files: [ // laya-model.yml 실행 40049858171 의 결과 (Artifacts: laya-multilingual-int8 — 만들 때마다 encoder 가 조금 달라서 올린 그 파일로 고정)
    { name: 'encoder.onnx', size: 309462936, sha256: '29f3cfa7b174867f3b4f004db222620bc75ad2e3dc945858b4d54e12f33e5a37' },
    { name: 'head.onnx', size: 228564, sha256: 'd59f297303127fd994aa331002afa5608a846545bfd2ac08587bd3faaf5c7f21' },
    { name: 'head.onnx.data', size: 59877376, sha256: '7b3c5cd0fa1bd10c1ce4ba1e7d9b218b3c1577ed6b1e5f39757b17cdc6b07605' },
    { name: 'tokenizer.json', size: 34363188, sha256: '609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f' },
    { name: 'rl_agent_config.json', size: 472, sha256: '25061739243b617ad88d1219ba6f8a9c86c5881ca28df024fa2d9b3b2fcc30c6' },
  ],
};
