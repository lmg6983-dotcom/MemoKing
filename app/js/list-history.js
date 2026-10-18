// 목록 창 "알림 보관함" 탭 — Windows 알림 기록 (갤럭시 NotiStar 처럼)
import { icon } from './icons.js';
import { hhmm } from './core/time.js';

// 알림 그림 주소 (안드로이드는 window.memoking.historyBase 로 자기 주소를 알려 준다)
const historyUrl = (name) => `${globalThis.memoking?.historyBase ?? 'memoking://history/'}${encodeURIComponent(name)}`;
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

function dayLabel(d, now = new Date()) {
  const key = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((key(now) - key(d)) / 86_400_000);
  if (diff === 0) return '오늘';
  if (diff === 1) return '어제';
  const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}년 `;
  return `${year}${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY[d.getDay()]})`;
}

// 앱 이름으로 늘 같은 색 (그림이 없을 때의 동그라미)
function appHue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// notify: 복사 등을 짧게 알리기 (PC 목록 창 안내 줄) · menu: 오른쪽 클릭 메뉴 띄우기 (PC — copy-content.js host.menu 와 같은 모양)
export function setupHistoryTab({ api, els, confirm, notify = null, menu = null }) {
  let query = '';
  let app = '';
  let data = { enabled: false, total: 0, apps: [], entries: [] };

  async function refresh() {
    data = await api.history.list({ query, app });
    render();
  }

  function avatar(e) {
    // 팝업 알림(카카오톡 등)의 그림은 알림 창을 찍은 것 → 동그라미 대신 글 아래에 크게
    if (e.image && e.source !== 'popup') {
      const img = document.createElement('img');
      img.className = 'avatar';
      img.src = historyUrl(e.image);
      img.alt = '';
      img.onerror = () => img.replaceWith(letter(e));
      return img;
    }
    return letter(e);
  }

  function letter(e) {
    const span = document.createElement('span');
    span.className = 'avatar letter';
    if (e.source === 'memoking') {
      span.classList.add('self');
      span.append(icon('bell'));
    } else {
      span.textContent = (e.app || '?').trim().charAt(0).toUpperCase();
      span.style.background = `hsl(${appHue(e.app)} 55% 50%)`;
    }
    return span;
  }

  // caption: 아이콘 밑 짧은 이름 (휴대폰은 마우스를 올려 볼 수 없어 보이게 — PC 는 숨기고 마우스 안내로)
  function actionButton(name, label, handler, caption = label) {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.title = label;
    b.setAttribute('aria-label', label);
    const cap = document.createElement('span');
    cap.className = 'cap';
    cap.setAttribute('aria-hidden', 'true');
    cap.textContent = caption;
    b.append(icon(name), cap);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      handler();
    });
    return b;
  }

  function row(e) {
    const d = new Date(e.time);
    const div = document.createElement('div');
    div.className = `row noti${e.source === 'memoking' ? ' self' : ''}`;
    div.dataset.id = e.id;

    // 글 부분은 단추: Tab 으로 가서 Enter·Space 로 펼치거나(메모킹 알림은) 그 메모 열기. 누르면 줄의 click 으로 이어진다
    const text = document.createElement('button');
    text.type = 'button';
    text.className = 'noti-text';
    if (!e.memoId) text.setAttribute('aria-expanded', 'false');
    const meta = document.createElement('span');
    meta.className = 'noti-meta';
    meta.textContent = `${e.app}, ${hhmm(d)}`;
    const title = document.createElement('span');
    title.className = 'noti-title';
    title.textContent = e.title;
    const body = document.createElement('span');
    body.className = 'noti-body';
    body.textContent = e.body;
    text.append(meta, title);
    // 알림 창 그림에서 글자 인식으로 읽은 글은 틀릴 수 있다고 알려 준다 (글자를 그대로 읽은 경우는 표시 없음)
    if (e.source === 'popup' && e.via === 'ocr') {
      const tag = document.createElement('span');
      tag.className = 'noti-via';
      tag.textContent = '글자 인식';
      tag.title = '알림 창에서 글자를 그대로 읽을 수 없어 그림에서 글자를 인식했어요. 틀린 글자가 있을 수 있어요';
      meta.append('  ', tag);
    }
    if (e.body) text.append(body);
    if (e.image && e.source === 'popup') {
      // 글을 읽었으면 글이 먼저 — 알림 창 그림은 눌러 펼쳤을 때만 (글을 못 읽은 알림은 그림을 늘 보인다)
      if (e.body) div.classList.add('has-text');
      const shot = document.createElement('img');
      shot.className = 'noti-shot';
      shot.src = historyUrl(e.image);
      shot.alt = `${e.app} 알림 창`;
      shot.loading = 'lazy';
      shot.onerror = () => shot.remove();
      text.append(shot);
    }

    const actions = document.createElement('div');
    actions.className = 'noti-actions';
    const toMemo = () => api.history.toMemo(e.id);
    const copy = async () => {
      try {
        await api.copyText([e.title, e.body].filter(Boolean).join('\n'));
        notify?.('알림 글을 복사했어요');
      } catch {
        notify?.('복사하지 못했어요');
      }
    };
    const remove = () => removeWithUndo(e, div);
    const block = api.history.block && e.source !== 'memoking' ? () => api.history.block(e) : null;
    actions.append(
      actionButton('note', '메모로 만들기', toMemo, '메모로'),
      actionButton('copy', '복사', copy),
      // 메모가 아니라 보관함의 이 알림 기록만 지운다
      actionButton('trash', '보관함에서 삭제', remove, '삭제'),
    );
    // 이 앱 알림 그만 모으기 (안드로이드)
    if (block) actions.append(actionButton('block', `${e.app} 알림 그만 모으기`, block, '그만 모으기'));
    // PC: 오른쪽 클릭(메뉴 키 · Shift+F10)으로 같은 일을 이름과 함께 · Delete 키로 지우기
    if (menu) {
      div.addEventListener('contextmenu', async (ev) => {
        ev.preventDefault();
        const r = div.getBoundingClientRect();
        const at = ev.button !== 2 ? { x: Math.round(r.left + 16), y: Math.round(r.top + 16) } : null; // 키보드(button 0)로 열면 그 줄 자리에
        const id = await menu([
          { id: 'memo', label: '메모로 만들기' },
          { id: 'copy', label: '복사' },
          ...(block ? [{ id: 'block', label: `${e.app} 알림 그만 모으기` }] : []),
          { type: 'separator' },
          { id: 'remove', label: '보관함에서 삭제', accelerator: 'Delete' },
        ], at);
        ({ memo: toMemo, copy, block, remove })[id]?.();
      });
      text.addEventListener('keydown', (ev) => {
        if (ev.key === 'Delete' && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) {
          ev.preventDefault();
          remove();
        }
      });
    }

    div.append(avatar(e), text, actions);
    // 누르면 내용 펼치기 / 메모킹 알림은 그 메모 열기
    div.addEventListener('click', () => {
      if (e.memoId) api.memo.open(e.memoId);
      else {
        // 펼친 알림은 하나만: 다른 알림을 누르면 앞의 것은 접는다
        const open = !div.classList.contains('expanded');
        for (const other of els.rows.querySelectorAll('.noti.expanded')) {
          other.classList.remove('expanded');
          other.querySelector('.noti-text')?.setAttribute('aria-expanded', 'false');
        }
        div.classList.toggle('expanded', open);
        text.setAttribute('aria-expanded', String(open));
      }
    });
    return div;
  }

  // 알림 하나 지우기: 바로 지우지 않고 그 자리에 "되돌리기" 를 5초 — 그동안 되돌리면 그대로 (메모 지우기처럼)
  const pendingRemoval = new Map(); // 알림 id → { timer, strip } (지울 시각까지 — 그사이 목록을 다시 그려도 되돌리기 띠는 그 자리에)
  function removeWithUndo(e, div) {
    const strip = document.createElement('div');
    strip.className = 'row noti-undo';
    strip.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = '알림을 삭제했어요';
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'link-btn';
    undo.textContent = '되돌리기';
    strip.append(text, undo);
    div.replaceWith(strip);
    undo.focus({ preventScroll: true });
    const timer = setTimeout(() => {
      pendingRemoval.delete(e.id);
      strip.remove();
      api.history.remove(e.id);
    }, 5000);
    pendingRemoval.set(e.id, { timer, strip });
    undo.addEventListener('click', (ev) => {
      ev.stopPropagation();
      clearTimeout(timer);
      pendingRemoval.delete(e.id);
      if (strip.isConnected) strip.replaceWith(div);
      else refresh();
    });
  }

  function render() {
    els.consent.hidden = data.enabled || data.total > 0;
    els.clear.disabled = !data.total; // 비울 것이 없으면
    // 꺼 둔 채 예전 알림만 남아 있으면 꺼져 있다는 것과 다시 켜는 단추를 맨 위에
    let off = els.body.querySelector('.history-off');
    if (!data.enabled && data.total > 0) {
      if (!off) {
        off = document.createElement('div');
        off.className = 'history-off';
        off.setAttribute('role', 'status');
        const t = document.createElement('span');
        t.textContent = '알림 보관이 꺼져 있어요. 새 알림은 모으지 않아요';
        const on = document.createElement('button');
        on.type = 'button';
        on.className = 'link-btn';
        on.textContent = '다시 켜기';
        on.addEventListener('click', async () => {
          await api.history.setEnabled(true);
          refresh();
        });
        off.append(t, on);
        els.rows.before(off);
      }
    } else off?.remove();
    els.body.hidden = !els.consent.hidden;

    const options = [['', `모든 앱 (${data.total})`], ...data.apps.map((a) => [a.name, `${a.name} (${a.count})`])];
    els.app.replaceChildren(...options.map(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      o.selected = value === app;
      return o;
    }));

    const nodes = [];
    let lastDay = '';
    for (const e of data.entries) {
      const day = dayLabel(new Date(e.time));
      if (day !== lastDay) {
        const h = document.createElement('h3');
        h.className = 'rows-title';
        h.textContent = day;
        nodes.push(h);
        lastDay = day;
      }
      nodes.push(pendingRemoval.get(e.id)?.strip ?? row(e)); // 되돌리기를 기다리는 중이면 그 띠를 그대로
    }
    els.rows.replaceChildren(...nodes);
    els.empty.hidden = data.entries.length > 0;
    els.empty.textContent = query || app
      ? '찾는 알림이 없어요.'
      : data.enabled ? '아직 모은 알림이 없어요.\n새 알림이 오면 여기에 모아둘게요.' : '알림 보관이 꺼져 있어요.\n설정 › 알림 모아두기에서 다시 켤 수 있어요.';
  }

  els.enable.addEventListener('click', async () => {
    await api.history.setEnabled(true);
    refresh();
  });
  els.clear.addEventListener('click', async () => {
    // 앱으로 거르거나 찾는 중이어도 보관함 전체를 비운다 — 보이는 것만 지우는 줄 알지 않게 알린다
    const narrowed = Boolean(query || app);
    const msg = narrowed
      ? `지금 보이는 알림만이 아니라, 보관한 알림 ${data.total}개를 모두 삭제할까요?\n되돌릴 수 없어요.`
      : `보관한 알림 ${data.total}개를 모두 삭제할까요?\n되돌릴 수 없어요.`;
    if (await confirm(msg, '모두 삭제')) api.history.clear();
  });
  els.app.addEventListener('change', () => {
    app = els.app.value;
    refresh();
  });

  return {
    refresh,
    setQuery(q) {
      query = q;
      refresh();
    },
  };
}
