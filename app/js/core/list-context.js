// 목록 머리의 한 줄: "메모 N개" 대신 지금 무엇을 보고 있는지 (휴대폰 큰 제목 아래 · PC 검색 줄 아래 같이)
//   보통: 고른 폴더 (전체면 "모든 메모") — Work / Life 를 나눠 쓰면 앞에 그 모드
//   검색 중: '검색어' 찾은 메모 N개 · 필터만: 필터 N개로 M개
import { UNFILED, UNFILED_LABEL } from './folders.js';
import { MODE_LABEL } from './modes.js';

/**
 * @param {{ folder?: string, mode?: string, workLife?: boolean, query?: string, filters?: number, shown: number }} o
 * @returns {string}
 */
export function listContext({ folder = '', mode = '', workLife = false, query = '', filters = 0, shown }) {
  const where = !folder ? '모든 메모' : folder === UNFILED ? UNFILED_LABEL : `${folder} 폴더`;
  const scope = workLife && MODE_LABEL[mode] ? `${MODE_LABEL[mode]} · ${where}` : where;
  const q = String(query ?? '').trim();
  if (q) return `'${q.length > 20 ? `${q.slice(0, 20)}…` : q}' 찾은 메모 ${shown}개${filters ? ` · 필터 ${filters}개` : ''}`;
  if (filters) return `${scope} · 필터 ${filters}개로 ${shown}개`;
  return scope;
}
