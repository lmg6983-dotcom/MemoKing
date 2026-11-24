// Google Drive 동기화 진행 글 — PC(app/js/drive-panel.js) · 휴대폰(android/web/js/drive.js)이 같은 글.
//   p: { phase: scan|compare|transfer, done, total, since } (desktop-rs/app/src/drive.rs · DriveSync.kt 가 보낸다)

/** 동기화 진행 한 줄: "Drive 폴더 살펴보는 중, 폴더 3/8개" · "양쪽 파일 비교하는 중, 120/400개" · "파일 12/40개 맞추는 중, 약 2분 남음" */
export function progressText(p, now = Date.now()) {
  if (!p) return '';
  // 폴더 수는 훑으며 늘어나니 남은 시간은 말하지 않는다
  if (p.phase === 'scan') return `Drive 폴더 살펴보는 중${p.total ? `, 폴더 ${p.done}/${p.total}개` : ''}`;
  if (!p.total) return '바뀐 메모가 없어요, 마무리하는 중';
  const left = etaText(p, now);
  const what = p.phase === 'compare' ? '양쪽 파일 비교하는 중, ' : '파일 ';
  return `${what}${p.done}/${p.total}개${p.phase === 'compare' ? '' : ' 맞추는 중'}${left ? `, ${left}` : ''}`;
}

/** 남은 시간 어림 — 처음 몇 개 · 몇 초는 들쭉날쭉하니 말하지 않는다 */
export function etaText(p, now = Date.now()) {
  if (!p?.total || p.done < 2 || p.done >= p.total || now - (p.since ?? now) < 2500) return '';
  const sec = ((now - p.since) / p.done) * (p.total - p.done) / 1000;
  if (sec < 15) return '곧 끝나요';
  if (sec < 60) return '1분 안에 끝나요';
  return `약 ${Math.round(sec / 60)}분 남음`;
}

/** 진행 막대 0~1 (살펴보는 중이면 null — 오가는 막대) */
export const progressFraction = (p) => (!p || p.phase === 'scan' ? null : p.total ? p.done / p.total : 1);
