// 정리 도우미 — Life 메모 중에 일 이야기 같은 메모를 골라 Work 로 옮기자고 권한다 (PC · 휴대폰 같은 규칙)
//   태그(#업무 · #회사 …)는 크게, 제목의 낱말은 중간, 본문의 낱말은 작게 친다. 손으로 고른 것만 옮긴다.
import { memoMode } from './modes.js';

const WORK_TAGS = ['업무', '회사', '일', '직장', 'work', 'job', 'office', '회의', '프로젝트', '팀', '거래처', '고객'];
const WORK_WORDS = [
  '회의', '미팅', '업무', '보고', '보고서', '견적', '거래처', '고객사', '클라이언트', '출장', '프로젝트', '마감', '결재', '계약',
  '기획', '발표', '회사', '팀장', '부장', '과장', '대리', '인수인계', '회의록', '주간 보고', '월간 보고', '분기', 'KPI', 'OKR',
  '업체', '납품', '발주', '인보이스', '세금계산서', '매출', '예산', '협업', '요청사항', '채용', '면접', '연차',
  '야근', '사내', '부서', '슬랙', 'Slack', 'Jira', '지라', '노션', 'Notion', 'PPT', '엑셀', '스프린트', '배포', '릴리스', '코드 리뷰',
];

const norm = (s) => String(s ?? '').toLowerCase();

/**
 * @param {object[]} memos 목록의 메모들 (title · preview · tags · mode)
 * @returns {{ memo: object, score: number, reasons: string[] }[]} 점수 높은 순
 */
export function suggestWork(memos, { limit = 40 } = {}) {
  const out = [];
  for (const memo of memos ?? []) {
    if (memoMode(memo) !== 'life') continue;
    const reasons = [];
    let score = 0;
    for (const t of memo.tags ?? []) {
      if (WORK_TAGS.includes(norm(t))) {
        score += 3;
        reasons.push(`#${t}`);
      }
    }
    const title = norm(memo.title);
    const body = memo.locked ? '' : norm(memo.preview);
    for (const w of WORK_WORDS) {
      const k = norm(w);
      if (title.includes(k)) {
        score += 2;
        reasons.push(w);
      } else if (body.includes(k)) {
        score += 1;
        reasons.push(w);
      }
    }
    if (score >= 2) out.push({ memo, score, reasons: [...new Set(reasons)].slice(0, 3) });
  }
  return out.sort((a, b) => b.score - a.score || String(b.memo.updated ?? '').localeCompare(String(a.memo.updated ?? ''))).slice(0, limit);
}
