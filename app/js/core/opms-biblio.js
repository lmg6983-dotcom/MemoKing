// OPMS 사건 서지사항 (순수 함수, 단위 테스트 대상) — 서지사항 복사 · 사건정보.txt · 메모로 만들기가 같은 항목 · 순서로 쓴다

const day = (d) => {
  const s = String(d ?? '').trim();
  return s.length >= 10 && s[4] === '-' && s[7] === '-' ? s.slice(0, 10) : s;
};

/** [이름, 값] — 비고는 있을 때만 */
export function biblioFields(c) {
  return [
    ['사무소관리번호', c.ourref], ['출원인관리번호', c.yourref], ['구분', c.div], ['출원인', c.applicant], ['발명자', c.inventor],
    ['수임일', day(c.d_accept)], ['출원번호', c.n_app], ['출원일', day(c.d_app)], ['등록번호', c.n_issue],
    ['등록일', day(c.d_issue)], ['발명명칭', c.title_kor], ['비고', c.memo],
  ].map(([k, v]) => [k, String(v ?? '').trim()]).filter(([k, v]) => v || k !== '비고');
}

/** 서지사항 전체 복사: "이름: 값" 한 줄씩 (빈 값은 -, 여러 줄 비고는 값 자리에 맞춰 들여 쓴다) */
export function biblioText(c) {
  const fields = biblioFields(c);
  const width = Math.max(...fields.map(([k]) => k.length));
  return fields.map(([k, v]) => {
    const head = `${k.padEnd(width, ' ')} : `;
    return head + (v || '-').replace(/\r\n?/g, '\n').split('\n').join(`\n${' '.repeat(head.length)}`);
  }).join('\n');
}
