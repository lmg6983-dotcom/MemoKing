// 팝업 알림(Windows 알림 센터를 쓰지 않는 앱의 알림 창) — 읽은 글을 알림 보관함 항목으로 (순수 함수, 단위 테스트 대상)

// 지켜볼 앱: 프로세스 이름 → 보관함에 보일 이름
export const POPUP_APPS = {
  KakaoTalk: '카카오톡',
};

export const popupAppName = (process) => POPUP_APPS[process] ?? process ?? '알 수 없는 앱';

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

// 같은 앱의 같은 알림을 짧은 시간 안에 두 번 넣지 않는다 (알림 창이 다시 그려지는 경우)
export function isRepeat(recent, entry, now = Date.now(), windowMs = 2 * 60 * 1000) {
  return recent.some((r) => r.app === entry.app && r.title === entry.title && r.body === entry.body && now - r.at < windowMs);
}
