// OPMS 창 — 매직키에서 사건을 고르면 열린다 (PC 전용, 사내망)
//   위: 관리번호·출원번호 찾기 + 고른 사건 머리줄(사무소/출원인 관리번호 · 출원인 · 명칭 · 해외출원 배지)
//   탭: 정보(서지 + 업무배분 + 신규성 의제 · 진행사항 · 메모) · 전자포대(골라 받기 / 전체 받기 → 저장 폴더 열기) · 청구서 · 해외출원
//   "메모로 만들기": 고른 사건의 서지 · 업무배분 · 해외출원을 새 메모 한 장으로
//   글은 모두 textContent 로 넣는다 (서버 값을 HTML 로 읽지 않는다)
import { progressItems, dueState } from './core/opms-progress.js';

const api = window.opms;
const $ = (id) => document.getElementById(id);
const form = $('op-form');
const input = $('op-input');
const head = $('op-head');
const tabsEl = $('op-tabs');
const main = $('op-main');
const foot = $('op-foot');

let current = null; // { case, foreign, summary, wrapperDir, host }
let tab = 'info';
let seq = 0;
const cache = new Map(); // `${idx}:${tab}` → 받아 온 자료

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
const dash = (v) => String(v ?? '').trim() || '-';
const day = (v) => {
  const s = String(v ?? '').trim();
  return s.length >= 10 && s[4] === '-' ? s.slice(0, 10) : s;
};

function message(text, kind = '') {
  main.replaceChildren(el('p', `op-msg ${kind}`, text));
}

/** 표: cols = [[머리, 값 꺼내기, 'num'?]] */
function table(cols, rows, { empty = '없어요' } = {}) {
  if (!rows.length) return el('p', 'op-msg', empty);
  const t = el('table', 'op-table');
  const thead = el('thead');
  const tr = el('tr');
  for (const [label, , kind] of cols) {
    const th = el('th', kind ?? '');
    th.append(label); // 글 또는 "모두 고르기" 칸
    tr.append(th);
  }
  thead.append(tr);
  const tbody = el('tbody');
  rows.forEach((r, i) => {
    const row = el('tr');
    for (const [, get, kind] of cols) {
      const v = get(r, i);
      const td = el('td', kind ?? '');
      if (v instanceof Node) td.append(v);
      else td.textContent = dash(v);
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) td.classList.add('date'); // 날짜는 한 줄로
      row.append(td);
    }
    tbody.append(row);
  });
  t.append(thead, tbody);
  return t;
}

// 값을 누르면 복사 (관리번호·출원번호 등)
function copyable(text) {
  const v = String(text ?? '').trim();
  if (!v) return '-';
  const b = el('button', 'op-copy', v);
  b.type = 'button';
  b.title = '눌러서 복사';
  b.addEventListener('click', async () => {
    await api.copy(v);
    b.classList.add('done');
    setTimeout(() => b.classList.remove('done'), 900);
  });
  return b;
}

// ---------- 사건 찾기 ----------

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  const my = ++seq;
  message('찾는 중…');
  let list;
  try {
    list = await api.search(q);
  } catch (err) {
    if (my === seq) message(errText(err), 'err');
    return;
  }
  if (my !== seq) return;
  if (!list.length) return message(`'${q}'와 맞는 사건이 없어요`);
  if (list.length === 1) return open(list[0].idx, 'info');
  // 여러 건: 고르기
  head.hidden = true;
  tabsEl.hidden = true;
  foot.hidden = true;
  const pick = (r) => {
    const b = el('button', 'op-pick', null);
    b.type = 'button';
    b.append(el('b', '', [r.ourref, r.yourref].filter(Boolean).join(' / ') || '-'), el('span', '', [r.n_app, r.applicant, r.title].filter(Boolean).join(', ')));
    b.addEventListener('click', () => open(r.idx, 'info'));
    return b;
  };
  main.replaceChildren(el('p', 'op-msg', `${list.length}건이 찾아졌어요 — 사건을 고르세요`), ...list.map(pick));
});

const errText = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function open(idx, which = 'info') {
  const my = ++seq;
  message('사건을 불러오는 중…');
  try {
    current = await api.case(idx);
  } catch (err) {
    if (my === seq) message(errText(err), 'err');
    return;
  }
  if (my !== seq) return;
  const c = current.case;
  $('op-our').textContent = dash(c.ourref);
  $('op-your').textContent = c.yourref ? ` / ${c.yourref}` : '';
  const badge = $('op-badge');
  badge.hidden = !current.summary;
  badge.textContent = current.summary;
  $('op-sub').textContent = [c.div, c.applicant, c.title_kor].filter(Boolean).join(', ');
  head.hidden = false;
  tabsEl.hidden = false;
  document.title = `OPMS — ${c.ourref || c.yourref || c.n_app || ''}`;
  show(which);
}

// ---------- 탭 ----------

tabsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) show(b.dataset.tab);
});
tabsEl.addEventListener('keydown', (e) => {
  if (!e.target.closest('[data-tab]')) return;
  const order = ['info', 'wrapper', 'bills', 'foreign'];
  const dir = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!dir) return;
  e.preventDefault();
  show(order[(order.indexOf(tab) + dir + order.length) % order.length]);
  tabsEl.querySelector(`[data-tab="${tab}"]`).focus();
});

async function load(kind, fn) {
  const key = `${current.case.idx}:${kind}`;
  if (!cache.has(key)) cache.set(key, fn(current.case.idx).catch((err) => { cache.delete(key); throw err; }));
  return cache.get(key);
}

async function show(which) {
  if (!current) return;
  tab = which;
  for (const b of tabsEl.querySelectorAll('[data-tab]')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1; // Tab 은 고른 탭 하나로 — 탭 사이는 ← →
  }
  main.setAttribute('aria-labelledby', `op-tab-${tab}`);
  foot.hidden = tab !== 'wrapper';
  const my = ++seq;
  const c = current.case;
  try {
    if (tab === 'info') {
      const work = el('p', 'op-msg', '불러오는 중…');
      const more = el('div', 'op-more');
      more.append(el('p', 'op-msg', '신규성 의제 · 진행사항 · 메모를 불러오는 중…'));
      main.replaceChildren(infoGrid(c), el('h3', 'op-h', '업무배분'), work, more);
      showDetails(more, my); // 업무배분과 따로 (한쪽이 늦거나 실패해도 다른 쪽은 보이게)
      let rows;
      try {
        rows = await load('mywork', api.mywork);
      } catch (err) {
        // 업무배분만 못 불러와도 위의 서지정보는 그대로 둔다
        if (my === seq) work.replaceWith(el('p', 'op-msg err', `업무배분을 불러오지 못했어요 — ${errText(err)}`));
        return;
      }
      if (my !== seq) return;
      work.replaceWith(table([
        ['업무', (r) => r.div_job],
        ['담당', (r) => (r.per_gubun ? `${dash(r.per_name)}(${r.per_gubun})` : r.per_name)],
        ['접수', (r) => day(r.d_rec)],
        ['기한', (r) => day(r.d_due)],
        ['완료', (r) => day(r.d_end)],
        ['상세', (r) => String(r.detail || r.memo || '').replace(/[\r\n]+/g, ' ')],
      ], rows, { empty: '배분된 업무가 없어요' }));
    } else if (tab === 'bills') {
      message('불러오는 중…');
      const rows = await load('bills', api.bills);
      if (my !== seq) return;
      main.replaceChildren(table([
        ['청구일', (r) => day(r.d_demand)],
        ['청구번호', (r) => r.n_demand],
        ['구분', (r) => r.div_sub || r.div],
        ['금액', (r) => r.amount, 'num'],
        ['관납료 제외', (r) => r.amount_off_fee, 'num'],
        ['내역', (r) => String(r.dem_memo || r.memo || '').replace(/[\r\n]+/g, ' ')],
      ], rows, { empty: '청구서가 없어요' }));
    } else if (tab === 'foreign') {
      const rows = current.foreign;
      const note = !rows.length && c.ck_out === 'Y'
        ? `해외출원 데이터는 없지만 해외출원 관리 대상이에요${[c.out_div && `구분 ${c.out_div}`, c.d_out_due && `기한 ${day(c.d_out_due)}`, c.d_out && `진행 ${day(c.d_out)}`].filter(Boolean).map((x) => ` · ${x}`).join('')}`
        : '연계된 해외출원이 없어요';
      main.replaceChildren(table([
        ['국가', (r) => r.app_ncode || r._div],
        ['구분', (r) => r._div],
        ['사무소관리번호', (r) => copyable(r.ourref)],
        ['출원인관리번호', (r) => r.yourref],
        ['출원번호', (r) => copyable(r.n_app)],
        ['출원일', (r) => r.d_app],
        ['상태', (r) => r.status],
        ['현지대리인', (r) => r.attorney_out],
      ], rows, { empty: note }));
    } else if (tab === 'wrapper') {
      await showWrapper(my);
    }
  } catch (err) {
    if (my === seq) message(errText(err), 'err');
  }
}

// 신규성 의제 · 진행사항 · 메모 — OPMS 에서 그 표를 찾은 것만 (못 찾으면 알리고 표 목록을 복사할 수 있게)
async function showDetails(box, my) {
  let d;
  try {
    d = await load('details', api.details);
  } catch (err) {
    if (my === seq) box.replaceChildren(el('p', 'op-msg err', `신규성 의제 · 진행사항 · 메모를 불러오지 못했어요 — ${errText(err)}`));
    return;
  }
  if (my !== seq) return;
  const out = [];
  if (d.novelty.length) {
    out.push(el('h3', 'op-h', '신규성 의제'));
    const dl = el('dl', 'op-info');
    for (const n of d.novelty) {
      const wrap = el('div');
      wrap.append(el('dt', '', n.label), el('dd', '', n.value));
      dl.append(wrap);
    }
    out.push(dl);
  }
  for (const sec of d.sections) {
    if (!sec.table) continue;
    out.push(el('h3', 'op-h', sec.label));
    if (sec.error) out.push(el('p', 'op-msg err', `불러오지 못했어요 — ${sec.error}`));
    else if (sec.id === 'progress') out.push(progressTimeline(sec.rows));
    else out.push(table(sec.columns.map((x) => [x.label, (r) => r[x.key]]), sec.rows, { empty: `${sec.label}이(가) 없어요` }));
  }
  const missing = d.missing.filter((m) => !(m === '신규성 의제' && d.novelty.length));
  if (missing.length) {
    const p = el('p', 'op-msg op-missing', `OPMS 에서 ${missing.join(' · ')} 표를 찾지 못했어요. `);
    const copy = el('button', 'op-link', '표 목록 복사');
    copy.type = 'button';
    copy.title = 'OPMS 의 표 이름과 열을 복사해요 — 메모킹 개발자에게 보내 주면 맞춰 드려요';
    copy.addEventListener('click', async () => {
      try {
        const n = await api.copySchema();
        copy.textContent = `✓ 표 ${n}개 복사했어요`;
      } catch (err) {
        copy.textContent = `복사하지 못했어요 — ${errText(err)}`;
      }
    });
    p.append(copy);
    out.push(p);
  }
  box.replaceChildren(...out);
}

// 진행사항: 넓은 표 대신 한 줄씩 — 날짜 · 수신/제출 · 서류 이름 · 기한, 아래에 메모와 접수번호·담당 등 (최신이 위)
function progressTimeline(rows) {
  const items = progressItems(rows);
  if (!items.length) return el('p', 'op-msg', '진행사항이 없어요');
  const list = el('ol', 'op-timeline');
  for (const it of items) {
    const li = el('li', `op-tl ${it.kind === '제출' ? 'sent' : 'recv'}`);
    const date = el('time', 'op-tl-date', it.date || '날짜 없음');
    const body = el('div', 'op-tl-body');
    const head = el('div', 'op-tl-head');
    head.append(el('span', 'op-tl-kind', it.kind), el('b', 'op-tl-title', it.title));
    if (it.due) {
      const state = dueState(it.due);
      const due = el('span', `op-tl-due ${state}`, `기한 ${it.due}`);
      if (state === 'past') due.title = '기한이 지났어요';
      head.append(due);
    }
    body.append(head);
    if (it.memo) body.append(el('p', 'op-tl-memo', it.memo));
    if (it.meta.length) {
      const meta = el('p', 'op-tl-meta');
      it.meta.forEach(([k, v], i) => {
        if (i) meta.append(' · ');
        meta.append(`${k} `);
        meta.append(el('span', 'op-tl-v', v));
      });
      body.append(meta);
    }
    li.append(date, body);
    list.append(li);
  }
  return list;
}

function infoGrid(c) {
  const dl = el('dl', 'op-info');
  const put = (label, value, wide = false) => {
    const wrap = el('div', wide ? 'wide' : '');
    const dd = el('dd');
    if (value instanceof Node) dd.append(value);
    else dd.textContent = dash(value);
    wrap.append(el('dt', '', label), dd);
    dl.append(wrap);
  };
  put('사무소관리번호', copyable(c.ourref));
  put('출원인관리번호', copyable(c.yourref));
  put('구분', c.div);
  put('수임일', day(c.d_accept));
  put('출원인', c.applicant);
  put('발명자', c.inventor);
  put('출원번호', copyable(c.n_app));
  put('출원일', day(c.d_app));
  put('등록번호', copyable(c.n_issue));
  put('등록일', day(c.d_issue));
  put('발명명칭', c.title_kor, true);
  if (String(c.memo ?? '').trim()) put('비고', c.memo, true);
  return dl;
}

// ---------- 전자포대 ----------

// 한 파일 바로 열기: 저장 폴더(사건 폴더)에 받아 두고 기본 앱으로 (이미 받은 파일은 그대로 연다)
function openButton(r) {
  const b = el('button', 'op-link op-open-file', '열기');
  b.type = 'button';
  const hint = `${r.name} — 저장 폴더에 받아 두고 열어요 (전에 받은 그 파일이면 그대로)`;
  b.title = hint;
  // 아래 막대의 상태 글: 그사이 다른 사건 · 다른 탭으로 옮겼거나, 받는 중(전체 · 고른 것 받기)이면 쓰지 않는다
  const say = (idx, cls, text) => {
    const s = foot.querySelector('.op-status');
    if (!s || tab !== 'wrapper' || current?.case.idx !== idx || (dl && !dl.done && dl.idx === idx)) return;
    s.className = `op-status ${cls}`;
    s.textContent = text;
    s.title = '';
  };
  b.addEventListener('click', async () => {
    const idx = current.case.idx;
    b.disabled = true;
    b.textContent = '여는 중…';
    try {
      const res = await api.openFile({ idx, upload: r.upload });
      b.title = hint;
      say(idx, res?.shown ? '' : 'ok', res?.shown ? `${r.name}: ${res.message}` : `✓ ${r.name} 열었어요`);
    } catch (err) {
      b.title = `${hint}\n지난번: ${errText(err)}`;
      say(idx, 'err', `${r.name}: ${errText(err)}`);
    } finally {
      b.textContent = '열기';
      b.disabled = false;
    }
  });
  return b;
}

let attach = [];
// 받는 중에 다른 탭에 다녀와도 진행 표시가 이어지고, 두 번 겹쳐 받지 않게 — { idx, text, cls, title, done }
let dl = null;
async function showWrapper(my) {
  message('전자포대 목록을 불러오는 중…');
  attach = await load('wrapper', api.attachments);
  if (my !== seq) return;
  const all = el('input');
  all.type = 'checkbox';
  all.setAttribute('aria-label', '모두 고르기');
  const boxes = [];
  const t = table([
    [all, (r) => {
      const b = el('input');
      b.type = 'checkbox';
      b.value = r.upload; // 서버 파일 경로로 고른다 (번호는 서버 목록이 바뀌면 달라질 수 있음)
      b.setAttribute('aria-label', `${r.name} 고르기`);
      b.addEventListener('change', sync);
      boxes.push(b);
      return b;
    }, 'chk'],
    ['No.', (r) => String(r.n), 'num'],
    ['등록일', (r) => r.date],
    ['문서명', (r) => r.doc],
    ...(attach.some((r) => r.summary) ? [['요약', (r) => r.summary, 'wide']] : []),
    ...(attach.some((r) => r.writer) ? [['등록자', (r) => r.writer]] : []),
    ['파일명', (r) => r.name],
    ['크기', (r) => r.size, 'num'],
    ['', (r) => openButton(r), 'act'],
  ], attach, { empty: '받을 수 있는 전자포대 파일이 없어요' });
  all.addEventListener('change', () => {
    for (const b of boxes) b.checked = all.checked;
    sync();
  });
  // 줄을 눌러도 고르기 (열기 단추는 빼고) · 줄을 두 번 누르면 바로 열기
  t.querySelector('tbody')?.addEventListener('dblclick', (e) => {
    if (e.target.closest('input, button')) return;
    e.target.closest('tr')?.querySelector('.op-open-file')?.click();
  });
  t.querySelector('tbody')?.addEventListener('click', (e) => {
    if (e.target.closest('input, button')) return;
    const b = e.target.closest('tr')?.querySelector('input[type="checkbox"]');
    if (!b) return;
    b.checked = !b.checked;
    sync();
  });
  main.replaceChildren(t);

  const dir = el('span', 'op-dir', current.wrapperDir);
  dir.title = current.wrapperDir;
  const change = el('button', 'op-link', '폴더 바꾸기');
  change.type = 'button';
  change.addEventListener('click', async () => {
    current.wrapperDir = await api.chooseDir();
    dir.textContent = current.wrapperDir;
    dir.title = current.wrapperDir;
  });
  const status = el('span', 'op-status');
  status.setAttribute('role', 'status');
  const busy = () => Boolean(dl && !dl.done);
  const paint = () => {
    if (!dl || dl.idx !== current.case.idx) return;
    status.className = `op-status ${dl.cls ?? ''}`;
    status.textContent = dl.text;
    status.title = dl.title ?? '';
    if (dl.done && dl.saved != null) {
      foot.querySelector('.op-open')?.remove();
      const openBtn = el('button', 'op-link op-open', '폴더 열기');
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => api.openFolder());
      status.after(openBtn);
    }
  };
  const getSome = el('button', 'op-btn', '고른 것 받기');
  getSome.type = 'button';
  const getAll = el('button', 'op-btn primary', `전체 받기 (${attach.length})`);
  getAll.type = 'button';
  getAll.disabled = !attach.length;
  foot.replaceChildren(el('span', 'op-label', '저장 위치'), dir, change, status, getSome, getAll);
  paint();

  function sync() {
    const n = boxes.filter((b) => b.checked).length;
    all.checked = n > 0 && n === boxes.length;
    all.indeterminate = n > 0 && n < boxes.length;
    getSome.textContent = n ? `고른 ${n}개 받기` : '고른 것 받기';
    getSome.disabled = !n || busy();
    getAll.disabled = !attach.length || busy();
    change.disabled = busy();
  }
  sync();

  async function run(isAll) {
    if (busy()) return;
    const uploads = boxes.filter((b) => b.checked).map((b) => b.value);
    const idx = current.case.idx;
    const names = new Map(attach.map((a) => [a.upload, a.name])); // 받는 사이 다른 사건을 열어도 이 사건의 이름으로 알리게
    dl = { idx, text: '받는 중…', cls: '', done: false };
    sync();
    paint();
    try {
      const res = await api.download({ idx, uploads, all: isAll });
      const parts = [`${res.saved}개 저장`];
      if (res.skipped) parts.push(`${res.skipped}개는 이미 있음`);
      if (res.failed.length) parts.push(`${res.failed.length}개 실패`);
      dl = {
        idx, done: true, saved: res.saved, cls: res.failed.length ? 'err' : 'ok',
        text: `${res.failed.length ? '' : '✓ '}${parts.join(', ')}${isAll ? ', 사건정보.txt 포함' : ''}`,
        title: res.failed.map((f) => `${(f.upload && names.get(f.upload)) || f.name}: ${f.error}`).join('\n'),
      };
    } catch (err) {
      dl = { idx, done: true, cls: 'err', text: errText(err) };
    }
    // 그사이 탭을 옮겼다 왔으면 새로 그린 막대에 (지금 보이는 것이 이 사건의 전자포대일 때만)
    if (tab === 'wrapper' && current.case.idx === idx) {
      const live = foot.querySelector('.op-status');
      if (live && live !== status) return show('wrapper');
      paint();
      sync();
    }
  }
  getSome.addEventListener('click', () => run(false));
  getAll.addEventListener('click', () => run(true));
}

api.onProgress((p) => {
  if (!dl || dl.done || !p.total || p.i >= p.total) return;
  dl.text = `받는 중… ${p.i + 1}/${p.total} ${p.name}`;
  const s = foot.querySelector('.op-status');
  if (s && tab === 'wrapper' && current?.case.idx === dl.idx) s.textContent = dl.text;
});

// 새로 고침: 이 사건의 업무배분 · 청구서 · 전자포대 · 해외출원을 서버에서 다시
$('op-refresh').addEventListener('click', () => {
  if (!current) return;
  for (const k of [...cache.keys()]) if (k.startsWith(`${current.case.idx}:`)) cache.delete(k);
  open(current.case.idx, tab);
});

// 메모로 만들기: 사건 정보를 메모 한 장으로 (메모 창이 열린다)
$('op-memo').addEventListener('click', async () => {
  if (!current) return;
  const b = $('op-memo');
  b.disabled = true;
  b.textContent = '만드는 중…';
  try {
    await api.toMemo(current.case.idx);
    b.textContent = '✓ 메모로 만들었어요';
  } catch (err) {
    b.textContent = '메모로 만들기';
    message(errText(err), 'err');
  } finally {
    setTimeout(() => {
      b.disabled = false;
      b.textContent = '메모로 만들기';
    }, 1500);
  }
});

// Esc: 찾는 칸에 글이 있으면 지우고, 아니면 창 닫기 (모두 찾기 창과 같게)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing) return;
  if (document.activeElement === input && input.value) {
    input.value = '';
    return;
  }
  window.close();
});

api.onShow(({ idx, tab: which }) => {
  if (idx) open(idx, which || 'info');
  else input.focus();
});
input.focus();
