// AI 태그 모델 (설정 › AI 태그 › 받기) — PC · 휴대폰이 같은 파일.
//   Laya 다국어 (convaiinnovations/laya-multilingual, Apache 2.0) 를 .github/workflows/laya-model.yml 이
//   ONNX 로 바꾸고 8비트로 줄인 것. 한 번 받으면 인터넷 없이. 파일마다 크기 · SHA-256 이 맞아야 넣는다
export const LAYA_MODEL = {
  label: 'Laya 다국어',
  approx: '약 400MB',
  license: 'Apache 2.0',
  base: 'https://github.com/lmg6983-dotcom/memoking-releases/releases/download/laya-multilingual-e4e9ddf/',
  files: [
    { name: 'encoder.onnx', size: 0, sha256: '' },
    { name: 'head.onnx', size: 0, sha256: '' },
    { name: 'tokenizer.json', size: 0, sha256: '' },
    { name: 'rl_agent_config.json', size: 0, sha256: '' },
  ],
};
