// 버전 기록 패널의 목록 — PC 메모 창과 휴대폰이 함께 쓴다.
// 버전마다 "언제" · 그때의 첫 줄들 · 되돌리기 단추. 되돌려도 지금 내용이 버전으로 남으니 묻지 않는다.
import { koClock, koMonthDay } from './core/time.js';

// "3분 전 (오후 3:20)", "어제 오후 3:20", "10월 5일 오후 3:20" — 같은 시간대 버전도 구별되게 늘 시각을 붙인다
export function versionWhen(iso, now = new Date()) {
  const d = new Date(iso);
  const clock = koClock(d);
  const mins = Math.floor((now - d) / 60_000);
  if (mins < 60) return `${mins < 1 ? '방금' : `${mins}분 전`} (${clock})`;
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
  list.replaceChildren(...versions.map((v) => {
    const li = document.createElement('li');
    li.className = 'version-item';
    const text = document.createElement('div');
    text.className = 'version-text';
    const when = document.createElement('b');
    when.textContent = versionWhen(v.at);
    when.title = new Date(v.at).toLocaleString('ko-KR');
    const title = document.createElement('span');
    title.className = 'version-title';
    title.textContent = v.title || '(제목 없음)';
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
