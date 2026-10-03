// 목록 창 "알림 보관함" 탭 — Windows 알림 기록 (갤럭시 NotiStar 처럼)
import { icon } from './icons.js';

const pad = (v) => String(v).padStart(2, '0');
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

export function setupHistoryTab({ api, els, confirm }) {
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

  function actionButton(name, label, handler) {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(icon(name));
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

    const text = document.createElement('div');
    text.className = 'noti-text';
    const meta = document.createElement('div');
    meta.className = 'noti-meta';
    meta.textContent = `${e.app} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const title = document.createElement('div');
    title.className = 'noti-title';
    title.textContent = e.title;
    const body = document.createElement('div');
    body.className = 'noti-body';
    body.textContent = e.body;
    text.append(meta, title);
    // 알림 창 그림에서 글자 인식으로 읽은 글은 틀릴 수 있다고 알려 준다 (글자를 그대로 읽은 경우는 표시 없음)
    if (e.source === 'popup' && e.via === 'ocr') {
      const tag = document.createElement('span');
      tag.className = 'noti-via';
      tag.textContent = '글자 인식';
      tag.title = '알림 창에서 글자를 그대로 읽을 수 없어 그림에서 글자를 인식했어요. 틀린 글자가 있을 수 있어요';
      meta.append(' · ', tag);
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
    actions.append(
      actionButton('note', '메모로 만들기', () => api.history.toMemo(e.id)),
      actionButton('copy', '복사', () => api.copyText([e.title, e.body].filter(Boolean).join('\n'))),
      actionButton('trash', '지우기', () => api.history.remove(e.id)),
    );
    // 이 앱 알림 그만 모으기 (안드로이드)
    if (api.history.block && e.source !== 'memoking') actions.append(actionButton('block', `${e.app} 알림 그만 모으기`, () => api.history.block(e)));

    div.append(avatar(e), text, actions);
    // 누르면 내용 펼치기 / 메모킹 알림은 그 메모 열기
    div.addEventListener('click', () => {
      if (e.memoId) api.memo.open(e.memoId);
      else {
        // 펼친 알림은 하나만: 다른 알림을 누르면 앞의 것은 접는다
        const open = !div.classList.contains('expanded');
        for (const other of els.rows.querySelectorAll('.noti.expanded')) other.classList.remove('expanded');
        div.classList.toggle('expanded', open);
      }
    });
    return div;
  }

  function render() {
    els.consent.hidden = data.enabled || data.total > 0;
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
      nodes.push(row(e));
    }
    els.rows.replaceChildren(...nodes);
    els.empty.hidden = data.entries.length > 0;
    els.empty.textContent = query || app
      ? '찾는 알림이 없어요.'
      : data.enabled ? '아직 모은 알림이 없어요.\n새 알림이 오면 여기에 모아둘게요.' : '알림 보관이 꺼져 있어요.\n설정에서 다시 켤 수 있어요.';
  }

  els.enable.addEventListener('click', async () => {
    await api.history.setEnabled(true);
    refresh();
  });
  els.clear.addEventListener('click', async () => {
    if (await confirm(`보관한 알림 ${data.total}개를 모두 지울까요?\n지운 알림은 되돌릴 수 없어요.`, '모두 지우기')) api.history.clear();
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
