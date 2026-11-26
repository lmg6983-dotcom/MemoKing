// 기기 상태 (_memoking/기기/<이름> (<id>).md) — 순수 함수 (Rust: core/src/devices.rs)
//   기기마다 자기 파일에 마지막 동기화 · 메모 폴더 · PC 다리 · 최근 오류를 적는다 → 이 파일도 동기화되니
//   다른 기기 · AI 가 "제1 PC 3분 전 동기화 · PC 다리 켜짐" 을 볼 수 있다.
//   AI 받은함 시트는 한 기기만 처리한다(inboxLeader): 켜져 있는 PC 가 먼저, 없으면 휴대폰 — 이름 차례로 첫째
import { titleToFileName } from './memo-file.js';
import { CONFLICT_TAG } from './conflicts.js';

export const DEVICES_DIR = '_memoking/기기';
export const ALIVE_MS = 15 * 60_000; // 이만큼 소식이 없으면 꺼진 기기로 본다
export const HEARTBEAT_MS = 5 * 60_000; // 바뀐 것이 없어도 이만큼마다 "살아 있음" 을 적는다

/** 기기 파일 경로: "_memoking/기기/DESKTOP-AB12 (3f9c).md" */
export const deviceFile = (name, id) => `${DEVICES_DIR}/${titleToFileName(`${name} (${id})`)}.md`;

const pad = (n) => String(n).padStart(2, '0');
/** 이 기기 시각으로 "2026-11-24 17:20" */
export function localStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 기기 파일의 글 — 머리말(기계가 읽는 칸) + 사람이 읽는 줄
 * @param {{ name: string, kind: 'pc'|'phone', alive: number, lastSync?: number, folder?: string, bridge?: string, error?: string }} d
 */
export function deviceText(d) {
  const kind = d.kind === 'pc' ? 'pc' : 'phone';
  const lines = [
    `- 종류: ${kind === 'pc' ? 'PC' : '휴대폰'}`,
    `- 마지막 동기화: ${d.lastSync ? localStamp(d.lastSync) : '아직 없음'}`,
    ...(d.folder ? [`- 메모 폴더: ${d.folder}`] : []),
    ...(kind === 'pc' ? [`- PC 다리: ${d.bridge ? `켜짐 (${d.bridge})` : '꺼짐 (Google Drive 데스크탑 앱 폴더를 찾지 못함)'}`] : []),
    `- 최근 오류: ${d.error || '없음'}`,
  ];
  return `---\nkind: ${kind}\nalive: ${Math.round(d.alive)}\nlastSync: ${Math.round(d.lastSync ?? 0)}\n---\n# ${d.name}\n\n${lines.join('\n')}\n`;
}

/** 기기 파일 → { name, kind, alive, lastSync, lines } (못 읽으면 null) */
export function parseDevice(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(String(text ?? '').replace(/\r\n/g, '\n'));
  if (!m) return null;
  const meta = {};
  for (const l of m[1].split('\n')) {
    const i = l.indexOf(': ');
    if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 2).trim();
  }
  const rest = String(text).replace(/\r\n/g, '\n').slice(m[0].length);
  const title = rest.split('\n').find((l) => l.startsWith('# '))?.slice(2).trim();
  const int = (v) => (/^-?\d+$/.test(v ?? '') ? Number(v) : null);
  const alive = int(meta.alive);
  if (!title || alive === null) return null;
  return {
    name: title,
    kind: meta.kind === 'pc' ? 'pc' : 'phone',
    alive,
    lastSync: int(meta.lastSync) ?? 0,
    lines: rest.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)),
  };
}

/**
 * AI 받은함 시트를 이 기기가 처리할 차례인가 — 켜져 있는(ALIVE_MS 안) 기기 가운데 PC 가 먼저, 이름 차례로 첫째.
 *   me 도 늘 켜져 있는 것으로 넣는다 (내 파일이 아직 Drive 에 없어도)
 * @param {Array<{ file: string, kind: string, alive: number }>} devices file: 기기 파일 이름
 */
export function inboxLeader(devices, me, now) {
  const live = devices.filter((d) => d.file !== me.file && !CONFLICT_TAG.test(d.file) && now - d.alive <= ALIVE_MS).concat([{ ...me, alive: now }]);
  const pcs = live.filter((d) => d.kind === 'pc');
  const pool = pcs.length ? pcs : live;
  const first = [...pool].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))[0];
  return first.file === me.file;
}

/** 다시 적을 때인가: HEARTBEAT_MS 지났거나 사람이 읽는 내용이 바뀌었다 — 마지막 동기화 시각은 빼고
 *   (동기화마다 적으면 그 파일을 올리느라 또 동기화하고, 기기마다 1분에 한 번씩 파일이 오간다) */
export function needsWrite(prevText, next, now) {
  const prev = parseDevice(prevText);
  if (!prev) return true;
  const draft = parseDevice(deviceText({ ...next, alive: now }));
  const keep = (lines) => lines.filter((l) => !l.startsWith('마지막 동기화')).join('\n');
  return now - prev.alive >= HEARTBEAT_MS || prev.name !== draft.name || keep(prev.lines) !== keep(draft.lines);
}

/** 화면에 한 줄: "제1 PC · PC · 3분 전 동기화" (꺼진 지 오래면 "꺼짐") */
export function deviceSummary(d, now) {
  const ago = (ms) => {
    const m = Math.max(0, Math.round((now - ms) / 60_000));
    return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 24 * 60 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
  };
  const off = now - d.alive > ALIVE_MS;
  return `${d.name} · ${d.kind === 'pc' ? 'PC' : '휴대폰'} · ${off ? `꺼짐 (${ago(d.alive)} 마지막)` : d.lastSync ? `${ago(d.lastSync)} 동기화` : '켜짐'}`;
}
