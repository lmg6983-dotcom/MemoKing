// 버전 기록 패널의 목록 — PC 메모 창과 휴대폰이 함께 쓴다.
// 버전마다 "언제" · 그때의 첫 줄들 · 되돌리기 단추. 되돌려도 지금 내용이 버전으로 남으니 묻지 않는다.
import { koClock, koMonthDay } from './core/time.js';
import { UI } from './core/ui-text.js';

// "3분 전 (오후 3:20)", "어제 오후 3:20", "10월 5일 오후 3:20" — 같은 시간대 버전도 구별되게 늘 시각을 붙인다
//   newest: 맨 위(가장 새) 버전만 "방금" — 아래 것까지 "방금" 이면 어느 쪽이 새것인지 몰랐다. seconds: 같은 분의 버전끼리는 초까지
export function versionWhen(iso, now = new Date(), { newest = true, seconds = false } = {}) {
  const d = new Date(iso);
  const clock = seconds ? `${koClock(d)}:${String(d.getSeconds()).padStart(2, '0')}` : koClock(d);
  const mins = Math.floor((now - d) / 60_000);
  if (mins < 1) return newest ? `방금 (${clock})` : `오늘 ${clock}`; // 1분이 안 됐어도 맨 위가 아니면 "방금" 대신 시각만
  if (mins < 60) return `${mins}분 전 (${clock})`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return `오늘 ${clock}`;
  if (days === 1) return `어제 ${clock}`;
  return `${koMonthDay(d)} ${clock}`;
}

/**
 * @param {HTMLElement} list <ul>
 * @param {{name: string, at: string, title: string, preview: string}[]} versions 새것 먼저
 * @param {(name: string) => void} onRestore
 */
export function renderVersions(list, versions, onRestore) {
  const now = new Date();
  const minute = (v) => Math.floor(new Date(v.at).getTime() / 60_000);
  list.replaceChildren(...versions.map((v, i) => {
    const sameMinute = versions.some((o, j) => j !== i && minute(o) === minute(v));
    const li = document.createElement('li');
    li.className = 'version-item';
    const text = document.createElement('div');
    text.className = 'version-text';
    const when = document.createElement('b');
    when.textContent = versionWhen(v.at, now, { newest: i === 0, seconds: sameMinute });
    when.title = new Date(v.at).toLocaleString('ko-KR');
    const title = document.createElement('span');
    title.className = 'version-title';
    title.textContent = v.title || UI.untitledParen;
    const preview = document.createElement('span');
    preview.className = 'version-preview';
    preview.textContent = v.preview;
    text.append(when, title, preview);
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'btn version-restore';
    restore.textContent = '되돌리기';
    restore.setAttribute('aria-label', `${when.textContent} 내용으로 되돌리기`);
    restore.addEventListener('click', () => onRestore(v.name));
    li.append(text, restore);
    return li;
  }));
}
