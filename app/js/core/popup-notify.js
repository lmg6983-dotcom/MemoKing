// 팝업 알림(Windows 알림 센터를 쓰지 않는 앱의 알림 창) — 읽은 글을 알림 보관함 항목으로 (순수 함수, 단위 테스트 대상)
import { UI } from './ui-text.js';

// 지켜볼 앱: 프로세스 이름 → 보관함에 보일 이름
export const POPUP_APPS = {
  KakaoTalk: '카카오톡',
};

export const popupAppName = (process) => POPUP_APPS[process] ?? process ?? UI.unknownApp;

// 알림 창 글에서 뺄 것: 앱 이름만 있는 줄, 시각만 있는 줄("오후 3:12", "15:12"), 버튼 글자
const NOISE = [
  /^(카카오톡|kakaotalk)$/i,
  /^(오전|오후)\s*\d{1,2}:\d{2}$/,
  /^\d{1,2}:\d{2}(\s*(AM|PM))?$/i,
  /^(닫기|답장|보기|확인|close|reply)$/i,
];

/**
 * 읽은 줄 → { title, body }. 첫 줄은 보낸 사람(제목), 나머지는 내용.
 * @param {string[]} lines
 * @param {{ appName?: string }} [options]
 */
export function popupToEntry(lines, { appName = '' } = {}) {
  const clean = [];
  for (const raw of lines ?? []) {
    const line = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!line || NOISE.some((re) => re.test(line)) || line === appName) continue;
    if (clean.at(-1) === line) continue;
    clean.push(line);
  }
  if (!clean.length) return null;
  const [title, ...rest] = clean;
  return { title: title.slice(0, 200), body: rest.join('\n').slice(0, 2000) };
}

// 글자만 (띄어쓰기 · 기호 · 읽는 방법마다 다른 줄 나눔은 빼고)
const letters = (text) => String(text ?? '').replace(/[^\p{L}\p{N}]/gu, '');
const overlaps = (a, b) => a === b || (Boolean(a && b) && (a.includes(b) || b.includes(a)));
export const SAME_WINDOW_MS = 15_000;

// 같은 앱의 같은 알림을 짧은 시간 안에 두 번 넣지 않는다 (알림 창이 다시 그려지는 경우).
//   같은 알림 창(hwnd)을 방금 읽었으면 글이 조금 달라도 같은 알림 — 바로 읽은 글과 글자 인식 결과처럼
//   제목 · 내용이 각각 한쪽이 다른 쪽을 담으면 ("김대리" · "김대리 (영업팀)")
export function isRepeat(recent, entry, now = Date.now(), windowMs = 2 * 60 * 1000) {
  return recent.some((r) => {
    if (r.app !== entry.app) return false;
    if (r.title === entry.title && r.body === entry.body && now - r.at < windowMs) return true;
    if (!entry.hwnd || r.hwnd !== entry.hwnd || now - r.at >= SAME_WINDOW_MS) return false;
    return overlaps(letters(r.title), letters(entry.title)) && overlaps(letters(r.body), letters(entry.body)) && Boolean(letters(r.title + r.body));
  });
}

// ---------- 카카오톡 PC 알림 창: 글자 인식 결과를 자리로 나누기 ----------
// 알림 창 모양 (위에서부터, 단위 = 100% 배율 화면 px):
//   맨 위 줄  채팅방 이름 (오른쪽 위에는 알림 끄기 종·닫기 단추 — 글자 인식이 '0'·'x' 로 잘못 읽는다)
//   둘째 줄   보낸 사람 (1:1 대화면 채팅방 이름과 같다)
//   그 아래   메시지 (KAKAO_BODY_Y 부터. 이모티콘·사진이면 없다)
// 참고: AIoish/ALTONG_client PR #18 (카카오톡 알림 창을 Windows 글자 인식으로 읽는 방식)
export const KAKAO_BODY_Y = 58;
const ICON_ZONE = { x: 0.7, y: 0.35 }; // 폭의 70% 오른쪽 · 높이의 35% 위 = 종·닫기 단추 자리
const CONTROL = /^(닫기|x|close|답장|reply|전송|보기|확인)$/i;

// 글자로 쓸 수 있는 조각인가 (기호만·단추 글자·잘못 읽은 한 글자는 빼고, 'ㅋㅋ'·'ㅠ' 같은 자모만의 메시지는 남긴다)
function usable(text) {
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  if (/^[0-9ox]$/i.test(text)) return false;
  const t = text.replace(/\s+/g, '').toLowerCase();
  return !CONTROL.test(t) && !t.includes('메시지입력') && !t.includes('아이콘표시');
}

// 채팅방 이름과 보낸 사람이 같은 이름인가 (1:1 대화) — 작은 글씨 · 굵은 글씨를 따로 읽어 한두 글자 다를 수 있다
function sameName(a, b) {
  const x = a.replace(/[^\p{L}\p{N}]/gu, '');
  const y = b.replace(/[^\p{L}\p{N}]/gu, '');
  if (!x || !y) return true;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  // 한 글자만 다르면 같은 이름으로 (글자 인식이 한 글자를 잘못 읽은 경우)
  if (Math.abs(x.length - y.length) > 1) return false;
  let diff = 0;
  for (let i = 0, j = 0; i < x.length || j < y.length; i++, j++) {
    if (x[i] === y[j]) continue;
    diff++;
    if (x.length > y.length) j--;
    else if (y.length > x.length) i--;
    if (diff > 1) return false;
  }
  return true;
}

/**
 * 글자 인식 결과(줄마다 글과 자리) → { title, body }
 * @param {{ text: string, x: number, y: number, w?: number, h?: number }[]} boxes 알림 창 왼쪽 위 기준 (100% 배율 px)
 * @param {{ width?: number, height?: number, appName?: string, profileTop?: number }} [size] 알림 창 크기 (100% 배율 px).
 *   profileTop: 프로필 사진 윗변(100% 배율 px). 그보다 위의 줄은 채팅방 이름, 아래 첫 줄이 보낸 사람, 나머지는 메시지.
 *   채팅방 이름이 보낸 사람과 같으면(1:1 대화) 보낸 사람만, 다르면(단체방) "보낸 사람 (채팅방)
 * @returns {{ title: string, body: string } | null}
 */
export function kakaoEntry(boxes, { width = 0, height = 0, appName = '', profileTop = 0 } = {}) {
  const items = [];
  for (const b of [].concat(boxes ?? [])) {
    const text = String(b?.text ?? '').replace(/\s+/g, ' ').trim();
    const x = Number(b?.x) || 0;
    const y = Number(b?.y) || 0;
    const h = Math.max(1, Number(b?.h) || 14);
    if (!text || !usable(text) || NOISE.some((re) => re.test(text)) || text === appName) continue;
    if (width && height && x > width * ICON_ZONE.x && y < height * ICON_ZONE.y) continue;
    items.push({ text, x, y, h });
  }
  if (!items.length) return null;
  // 같은 높이(세로 가운데가 글자 높이의 절반 안)에 있는 조각은 한 줄로, 왼쪽부터
  items.sort((a, b) => a.y - b.y);
  const rows = [];
  for (const it of items) {
    const row = rows.find((r) => Math.abs((r.y + r.h / 2) - (it.y + it.h / 2)) < Math.min(r.h, it.h) / 2);
    if (row) row.parts.push(it);
    else rows.push({ y: it.y, h: it.h, parts: [it] });
  }
  const lines = rows.map((r) => ({ y: r.y, text: r.parts.sort((a, b) => a.x - b.x).map((p) => p.text).join(' ') }));

  let room;
  let sender;
  let body;
  const below = profileTop > 0 ? lines.filter((l) => l.y >= profileTop - 4) : [];
  if (below.length) {
    // 프로필 사진 윗변을 안다: 그 위 = 채팅방 이름, 아래 첫 줄 = 보낸 사람
    // 오른쪽 위 종 · 닫기 단추가 채팅방 줄 끝에 '×' · 'x' · '0' 같은 한 글자로 붙어 읽히면 뗀다
    const roomLine = lines.filter((l) => l.y < profileTop - 4).map((l) => l.text).join(' ')
      .replace(/(\s+(?:[^\p{L}\p{N}\s]{1,2}|[xXoO0]))+$/u, '').trim();
    sender = below[0].text;
    room = roomLine && !sameName(roomLine, sender) ? roomLine : sender;
    body = below.slice(1).map((l) => l.text);
  } else if (lines.length === 1) {
    [room, sender, body] = [lines[0].text, lines[0].text, []];
  } else if (lines[1].y >= KAKAO_BODY_Y || lines[0].text === lines[1].text) {
    // 윗줄 하나 + 메시지 (1:1 대화에서 보낸 사람 줄이 따로 없거나 같은 글로 두 번 읽힌 경우)
    const rest = lines.slice(1).map((l) => l.text);
    if (rest[0] === lines[0].text) rest.shift();
    [room, sender, body] = [lines[0].text, lines[0].text, rest];
  } else {
    [room, sender, body] = [lines[0].text, lines[1].text, lines.slice(2).map((l) => l.text)];
  }
  const title = room && room !== sender ? `${sender} (${room})` : sender;
  return { title: title.slice(0, 200), body: body.join('\n').slice(0, 2000) };
}

// ---------- 이미 받은 이름으로 맞추기 ----------
// 채팅방 이름(작은 글씨)과 보낸 사람 이름은 같은 것이 되풀이해 온다. 처음 보는 이름이 이미 받은 이름과 한 글자만 다르면
// (글자 인식이 한 글자를 잘못 읽음) 그 이름으로 맞춘다. 이미 받은 이름은 대개 그대로 둔다 (먼저 잘못 읽은 이름이 맞는 이름을 덮지 않게).

const nameKey = (s) => String(s ?? '').replace(/\s+/g, '');

// 한 글자 차이(바뀜 · 빠짐 · 더해짐)인가 — 두 글자 넘는 이름만 (짧은 이름은 한 글자 차이로도 다른 사람)
function oneOff(a, b) {
  if (a === b || a.length < 3 || b.length < 3 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** "보낸 사람 (채팅방)" → { sender, room } */
export function splitTitle(title) {
  const m = /^(.*\S)\s+\(([^()]*)\)$/.exec(String(title ?? '').trim());
  return m ? { sender: m[1], room: m[2] } : { sender: String(title ?? '').trim(), room: '' };
}

/** 이미 받은 알림 제목들에서 이름별 횟수 */
export function knownNames(titles) {
  const count = new Map();
  for (const t of titles) {
    const { sender, room } = splitTitle(t);
    for (const n of [sender, room]) if (n) count.set(n, (count.get(n) ?? 0) + 1);
  }
  return count;
}

// 처음 보는 이름 → 한 글자 차이인 이미 받은 이름 가운데 가장 자주 온 것으로.
// 이미 받은 이름이라도 한 글자 차이인 이름이 훨씬 자주(3배 넘게, 3번 넘게) 왔으면 그쪽이 맞는 이름
function fixName(name, known) {
  if (!name) return name;
  const mine = known.get(name) ?? 0;
  const key = nameKey(name);
  let best = null;
  for (const [cand, n] of known) {
    if (cand === name || !oneOff(key, nameKey(cand))) continue;
    if (!best || n > best.n) best = { cand, n };
  }
  if (!best) return name;
  if (mine === 0 || (best.n >= 3 && best.n > mine * 3)) return best.cand;
  return name;
}

/** 알림 제목의 보낸 사람 · 채팅방 이름을 이미 받은 이름으로 맞춘다 (known: knownNames 결과) */
export function correctTitle(title, known) {
  const { sender, room } = splitTitle(title);
  const s = fixName(sender, known);
  const r = fixName(room, known);
  return r ? `${s} (${r})` : s;
}
