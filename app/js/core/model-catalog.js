// 기본 모델 (설정 › AI 도우미 › 기본 모델 받기) — PC 만 (휴대폰은 0.47.0 부터 AI 없음).
//   카카오 카나나2 3B instruct (Qwen3 구조라 llama.cpp 가 그대로 돌림). 카나나 라이선스는 제3자용 온디바이스 제공에 별도 계약이
//   필요해, 메모킹은 본인 · 사내용으로만 쓰고 'Powered by Kanana' 와 라이선스를 설정에 보인다.
//   앱에 넣으면 설치 파일 · 업데이트가 GB 단위로 커져서, 인터넷이 될 때 한 번 Hugging Face 에서 받는다. 그다음은 인터넷 없이
export const DEFAULT_MODEL = {
  role: 'chat',
  label: '카나나2 3B',
  repo: 'mradermacher/kanana-2-3b-instruct-i1-GGUF', // kakaocorp/kanana-2-3b-instruct 를 imatrix 4비트로 — 같은 크기의 보통 4비트보다 품질 손실이 작다
  file: /\.i1-Q4_K_M\.gguf$/i,
  approx: '약 2.0GB',
  license: 'Kanana Open License',
  licenseUrl: 'https://huggingface.co/kakaocorp/kanana-2-3b-instruct/raw/main/LICENSE',
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
