// OPMS 진행사항 → 한 줄씩 읽기 좋은 타임라인 (OPMS 창 · "메모로 만들기" 함께, 순수 함수)
//   OPMS 진행사항 줄은 받은 서류(rec_doc · d_noti · no_rec)와 낸 서류(pre_doc · d_pre · pre_div)가 한 표에 섞여 있다.
//   줄마다 날짜 · 수신/제출 · 서류 이름 · 메모 · 기한 · 그 밖의 정보(접수번호 · 담당 …)로 묶고, 최신이 위로.

// 화면에 보이지 않을 열 (순서 · 부서 코드 · 등록 정보)
const SKIP = new Set(['sort', 'part_code', 'reg_per', 'd_reg', 'reg_date', 'idx', 'del_flag']);
// 묶음에 이미 쓴 열
const USED = new Set(['d_pre', 'pre_doc', 'd_noti', 'd_rec', 'rec_doc', 'rec_memo', 'memo', 'd_due', 'no_rec', 'pre_div', 'clerk', 'n_extend']);
// 그 밖의 열 이름 (모르는 열은 이름 그대로)
const LABELS = { no_rec: '접수번호', d_noti: '통지일', d_rec: '접수일', pre_div: '제출처', clerk: '담당', d_due: '기한', status: '상태' };

/**
 * @param {Array<Record<string, string>>} rows 진행사항 줄 (열 이름은 OPMS 그대로)
 * @returns {Array<{ date: string, kind: '수신'|'제출', title: string, memo: string, due: string, meta: Array<[string, string]> }>}
 */
export function progressItems(rows) {
  const items = (rows ?? []).map((raw, i) => {
    const r = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), String(v ?? '').trim()]));
    const v = (k) => (r[k] && r[k] !== '-' ? r[k] : '');
    const sent = Boolean(v('pre_doc') || v('d_pre')) && !v('rec_doc');
    const meta = [];
    if (v('no_rec')) meta.push(['접수번호', v('no_rec')]);
    if (!sent && v('d_rec') && v('d_rec') !== v('d_noti')) meta.push(['접수일', v('d_rec')]);
    if (v('pre_div')) meta.push(['제출처', v('pre_div')]);
    if (v('clerk')) meta.push(['담당', v('clerk')]);
    if (Number(v('n_extend')) > 0) meta.push(['연장', `${Number(v('n_extend'))}회`]);
    for (const [k, val] of Object.entries(r)) {
      if (SKIP.has(k) || USED.has(k) || !val || val === '-') continue;
      meta.push([LABELS[k] ?? k, val]);
    }
    return {
      date: sent ? v('d_pre') || v('d_rec') : v('d_noti') || v('d_rec') || v('d_pre'),
      kind: sent ? '제출' : '수신',
      title: v('rec_doc') || v('pre_doc') || '(서류 이름 없음)',
      memo: v('rec_memo') || v('memo'),
      due: v('d_due'),
      meta,
      order: Number(v('sort')) || i,
    };
  });
  // 최신이 위로 (날짜가 같거나 없으면 OPMS 순서의 뒤쪽이 위)
  items.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.order - a.order);
  return items.map(({ order: _o, ...x }) => x);
}

/** 기한이 지났나 · 곧인가 (오늘부터 days 일 안) */
export function dueState(due, now = new Date(), days = 30) {
  const t = Date.parse(due);
  if (!due || Number.isNaN(t)) return '';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t < today) return 'past';
  return t - today <= days * 86400_000 ? 'soon' : 'later';
}
