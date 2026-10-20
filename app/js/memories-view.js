// 추억 달력 (일정 탭 › 추억) — PC 목록 창 · 휴대폰이 같이 쓴다. 모으는 규칙은 core/memories.js
//   ① 사진 달력: 칸마다 그날의 대표 사진(여러 장이면 뒤에 살짝 기운 사진 더미), 글만 있는 날은 그 메모 색 메모지 조각
//   ② 맨 위 표지 띠: "10월의 기록 · 12일 · 사진 48장" + 그 달의 사진 몇 장(폴라로이드) + 태그로 고르기
//   ③ 날을 누르면 그날의 기록: 스크랩북 한 쪽 — 사진은 테이프 붙인 폴라로이드, 메모는 메모지 조각 · 좌우로 다른 날
import { collectMemories, monthSummary, neighborDays, dayKey, keyDate } from './core/memories.js';
import { vaultUrl } from './media.js';
import { koFullDate } from './core/time.js';
import { icon } from './icons.js';

const el = (tag, className = '', text = '') => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};
// 사진마다 늘 같은 기울기 · 테이프 자리 (다시 그려도 흔들리지 않게)
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const tilt = (s, max = 4) => {
  const t = (Math.abs(hash(s)) % (max * 20 + 1)) / 10 - max;
  return (t < 0 ? Math.min(t, -max * 0.3) : Math.max(t, max * 0.3)).toFixed(1); // 너무 반듯하면 붙인 맛이 없다
};
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * @param {{ api: any, notify?: (text: string, isError?: boolean) => void, onOverlay?: (el: HTMLElement, close: () => void) => (() => void),
 *           collage?: (o: { title: string, sub: string, photos: object[], memos: object[] }) => void }} o
 *   onOverlay: 그날의 기록을 열 때 (휴대폰: 뒤로 가기로 닫히게 등록 — 돌려준 함수는 닫을 때 부른다)
 *   collage: 한 장으로 남기기 (memories-collage.js)
 */
export function setupMemoriesView({ api, notify = () => {}, onOverlay = null, collage = null }) {
  const root = el('div', 'mem');
  let memos = [];
  let month = new Date(); // 보이는 달 (1일)
  let picked = []; // 고른 태그
  let days = new Map(); // 보이는 달의 기록
  let loaded = false;

  async function load() {
    try {
      memos = (await api.memos.list()) ?? [];
      loaded = true;
    } catch (err) {
      console.warn('[추억]', err);
      memos = [];
    }
  }

  function monthRange(d) {
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { first, last, from: dayKey(first), to: dayKey(last) };
  }

  // ---------- ① · ② 사진 달력 + 표지 띠 ----------
  function render() {
    const { first, last, from, to } = monthRange(month);
    days = collectMemories(memos, { from, to, tags: picked });
    const all = collectMemories(memos, { from, to }); // 태그 칩은 고르기 전 것으로
    const sum = monthSummary(days);
    const tags = monthSummary(all).tags.slice(0, 12);

    const head = el('div', 'mem-head');
    const words = el('div', 'mem-words');
    words.append(el('b', 'mem-title', `${month.getMonth() + 1}월의 기록`));
    words.append(el('span', 'mem-sub', sum.days ? `${sum.days}일 · 사진 ${sum.photos}장` : '아직 남긴 기록이 없어요'));
    head.append(words);
    if (sum.cover.length) {
      const strip = el('div', 'mem-cover');
      strip.setAttribute('aria-hidden', 'true');
      sum.cover.forEach((p, i) => {
        const pol = el('span', 'mem-cover-pol');
        pol.style.setProperty('--r', `${tilt(p.src, 7)}deg`);
        pol.style.setProperty('--i', String(i));
        const img = el('img');
        img.src = vaultUrl(p.src);
        img.alt = '';
        img.loading = 'lazy';
        img.draggable = false;
        pol.append(img);
        strip.append(pol);
      });
      head.append(strip);
    }
    if (collage && sum.days) {
      const share = el('button', 'mem-share');
      share.type = 'button';
      share.append(icon('share'), el('span', '', '한 장으로'));
      share.title = '이 달의 기록을 그림 한 장으로 (공유 · 저장)';
      share.addEventListener('click', () => collage({
        title: `${month.getFullYear()}년 ${month.getMonth() + 1}월의 기록`,
        sub: `${sum.days}일 · 사진 ${sum.photos}장`,
        photos: [...days.values()].flatMap((d) => d.photos.slice(0, 1).map((p) => ({ ...p, day: d.day }))),
        memos: [...days.values()].filter((d) => !d.photos.length).map((d) => ({ ...d.memos[0], day: d.day })),
        kind: 'month',
      }));
      head.append(share);
    }

    const chips = el('div', 'mem-tags');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', '태그로 고르기');
    chips.hidden = !tags.length;
    for (const t of tags) {
      const b = el('button', 'tag-chip mem-tag', `#${t.name}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(picked.includes(t.name)));
      b.addEventListener('click', () => {
        picked = picked.includes(t.name) ? picked.filter((x) => x !== t.name) : [...picked, t.name];
        render();
      });
      chips.append(b);
    }

    const grid = el('div', 'mem-grid');
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', `${month.getMonth() + 1}월 추억 달력`);
    const week = el('div', 'mem-week mem-weekdays');
    WEEK.forEach((w, i) => week.append(el('span', i === 0 ? 'mem-wd mem-sun' : 'mem-wd', w)));
    grid.append(week);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    const todayKey = dayKey(new Date());
    for (let d = new Date(start); d <= last || d.getDay() !== 0; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 0) grid.append(el('div', 'mem-week'));
      const row = grid.lastChild;
      const key = dayKey(d);
      const inMonth = d.getMonth() === month.getMonth();
      const rec = inMonth ? days.get(key) : null;
      row.append(dayCell(d, key, rec, { inMonth, today: key === todayKey }));
    }
    root.replaceChildren(head, chips, grid);
    if (loaded && !memos.length) root.append(el('p', 'mem-empty', '메모에 사진을 넣거나 글을 쓰면 그날 칸에 모여요. 여행 · 데이트 기록을 남겨 보세요.'));
  }

  function dayCell(d, key, rec, { inMonth, today }) {
    const cell = el(rec ? 'button' : 'div', 'mem-day');
    cell.setAttribute('role', 'gridcell');
    cell.dataset.date = key;
    if (!inMonth) cell.classList.add('mem-out');
    if (today) cell.classList.add('mem-today');
    if (d.getDay() === 0) cell.classList.add('mem-sun');
    const num = el('span', 'mem-num', String(d.getDate()));
    if (rec?.photos.length) {
      cell.classList.add('has-photo');
      if (rec.photos.length > 1) cell.classList.add('many');
      const img = el('img', 'mem-photo');
      img.src = vaultUrl(rec.photos[0].src);
      img.alt = '';
      img.loading = 'lazy';
      img.draggable = false;
      img.onerror = () => cell.classList.add('broken');
      cell.append(img, num);
      if (rec.photos.length > 1) cell.append(el('span', 'mem-count', String(rec.photos.length)));
    } else if (rec) {
      cell.classList.add('has-note');
      const paper = el('span', 'mem-paper', rec.memos[0].title || rec.memos[0].preview || '');
      paper.dataset.color = rec.memos[0].color ?? 'yellow';
      cell.append(num, paper);
    } else cell.append(num);
    if (rec) {
      cell.type = 'button';
      cell.setAttribute('aria-label', `${koFullDate(d)} · ${rec.photos.length ? `사진 ${rec.photos.length}장 · ` : ''}메모 ${rec.memos.length}개`);
      cell.addEventListener('click', () => openDay(key));
    }
    return cell;
  }

  // ---------- ③ 그날의 기록 (스크랩북 한 쪽) ----------
  let album = null;
  function openDay(key) {
    closeDay();
    const rec = days.get(key);
    if (!rec) return;
    const overlay = el('div', 'mem-album');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', `${koFullDate(keyDate(key))}의 기록`);
    const page = el('div', 'mem-page');
    const top = el('div', 'mem-page-top');
    const date = keyDate(key);
    const h = el('h2', 'mem-page-date');
    h.append(el('b', '', `${date.getMonth() + 1}월 ${date.getDate()}일`), el('span', '', ` ${'일월화수목금토'[date.getDay()]}요일`));
    const tools = el('div', 'mem-page-tools');
    const { prev, next } = neighborDays(days, key);
    const navBtn = (to, label, cls) => {
      const b = el('button', `icon-btn mem-nav ${cls}`);
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.append(icon('chev-right'));
      b.disabled = !to;
      b.addEventListener('click', () => to && openDay(to));
      return b;
    };
    tools.append(navBtn(prev, '이전 기록', 'mem-prev'), navBtn(next, '다음 기록', 'mem-next'));
    if (collage) {
      const share = el('button', 'icon-btn mem-page-share');
      share.type = 'button';
      share.setAttribute('aria-label', '이 날을 그림 한 장으로');
      share.title = '이 날을 그림 한 장으로 (공유 · 저장)';
      share.append(icon('share'));
      share.addEventListener('click', () => collage({
        title: `${date.getMonth() + 1}월 ${date.getDate()}일 ${'일월화수목금토'[date.getDay()]}요일`,
        sub: rec.memos.map((m) => m.title).filter(Boolean).slice(0, 3).join(' · '),
        photos: rec.photos.map((p) => ({ ...p, day: key })),
        memos: rec.memos.filter((m) => !m.images?.length).map((m) => ({ ...m, day: key })),
        kind: 'day',
      }));
      tools.append(share);
    }
    const close = el('button', 'icon-btn mem-close');
    close.type = 'button';
    close.setAttribute('aria-label', '닫기');
    close.append(icon('close'));
    close.addEventListener('click', () => closeDay());
    tools.append(close);
    top.append(h, tools);

    const board = el('div', 'mem-board');
    // 메모마다: 쓴 글(메모지) 다음에 사진들 — 사진 아래 이름은 첫 장에만
    for (const m of rec.memos) {
      if (!m.images?.length || m.preview) board.append(notePaper(m));
      (m.images ?? []).forEach((src, i) => board.append(polaroid(src, m, i === 0)));
    }
    page.append(top, board);
    overlay.append(page);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeDay();
    });
    // 좌우로 밀어 다른 날 (손가락) · ← → (키보드)
    let sx = null;
    page.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') sx = { x: e.clientX, y: e.clientY };
    });
    page.addEventListener('pointerup', (e) => {
      if (!sx) return;
      const dx = e.clientX - sx.x;
      const dy = e.clientY - sx.y;
      sx = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        const to = dx < 0 ? next : prev;
        if (to) openDay(to);
      }
    });
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (overlay.querySelector('.mem-zoom')) overlay.querySelector('.mem-zoom').remove();
        else closeDay();
      } else if (e.key === 'ArrowLeft' && prev) openDay(prev);
      else if (e.key === 'ArrowRight' && next) openDay(next);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    const release = onOverlay?.(overlay, () => closeDay()) ?? null;
    album = { overlay, cleanup: () => document.removeEventListener('keydown', onKey, true), release };
    close.focus({ preventScroll: true });
  }

  function closeDay() {
    if (!album) return;
    const { overlay, cleanup, release } = album;
    album = null;
    cleanup();
    release?.();
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 160);
  }

  function polaroid(src, memo, named = true) {
    const fig = el('figure', 'mem-pol');
    fig.style.setProperty('--r', `${tilt(src, 3.5)}deg`);
    fig.style.setProperty('--tape', `${tilt(`${src}t`, 12)}deg`);
    const tape = el('span', 'mem-tape');
    tape.setAttribute('aria-hidden', 'true');
    const b = el('button', 'mem-pol-img');
    b.type = 'button';
    b.setAttribute('aria-label', `${memo.title || '사진'} 크게 보기`);
    const img = el('img');
    img.src = vaultUrl(src);
    img.alt = memo.title || '';
    img.draggable = false;
    b.append(img);
    b.addEventListener('click', () => zoom(src, memo));
    const cap = el('figcaption', 'mem-cap', named ? memo.title || '' : '');
    fig.append(tape, b, cap);
    return fig;
  }

  function notePaper(memo) {
    const b = el('button', 'mem-note');
    b.type = 'button';
    b.dataset.color = memo.color ?? 'yellow';
    b.style.setProperty('--r', `${tilt(memo.id, 3)}deg`);
    b.append(el('b', 'mem-note-title', memo.title || '메모'));
    if (memo.preview) b.append(el('span', 'mem-note-text', String(memo.preview).slice(0, 160)));
    b.title = '메모 열기';
    b.addEventListener('click', () => openMemo(memo.id));
    return b;
  }

  function zoom(src, memo) {
    const box = el('div', 'mem-zoom');
    const img = el('img');
    img.src = vaultUrl(src);
    img.alt = memo.title || '';
    const open = el('button', 'btn mem-zoom-open', '메모 열기');
    open.type = 'button';
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      openMemo(memo.id);
    });
    box.append(img, open);
    box.addEventListener('click', () => box.remove());
    album?.overlay.append(box);
  }

  function openMemo(id) {
    closeDay();
    Promise.resolve(api.memo?.open?.(id)).catch((err) => notify(err?.message ?? '메모를 열지 못했어요', true));
  }

  return {
    el: root,
    /** 이 달을 보인다 (메모를 새로 읽어서) */
    async show(date) {
      month = new Date(date.getFullYear(), date.getMonth(), 1);
      await load();
      render();
    },
    /** 메모가 바뀌었을 때 (보이는 중이면) */
    async refresh() {
      await load();
      render();
      if (album) closeDay();
    },
    openDay,
    closeDay,
    isOpen: () => Boolean(album),
  };
}
