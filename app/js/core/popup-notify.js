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

/**
 * 글자 인식 결과(줄마다 글과 자리) → { title, body }
 * @param {{ text: string, x: number, y: number, w?: number, h?: number }[]} boxes 알림 창 왼쪽 위 기준 (100% 배율 px)
 * @param {{ width?: number, height?: number, appName?: string }} [size] 알림 창 크기 (100% 배율 px)
 * @returns {{ title: string, body: string } | null}
 */
export function kakaoEntry(boxes, { width = 0, height = 0, appName = '' } = {}) {
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
  if (lines.length === 1) {
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
