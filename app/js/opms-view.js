// OPMS 창 — 매직키에서 사건을 고르면 열린다 (PC 전용, 사내망)
//   위: 관리번호·출원번호 찾기 + 고른 사건 머리줄(사무소/출원인 관리번호 · 출원인 · 명칭 · 해외출원 배지)
//   탭: 정보(서지 + 업무배분) · 전자포대(골라 받기 / 전체 받기 → 저장 폴더 열기) · 청구서 · 해외출원
//   글은 모두 textContent 로 넣는다 (서버 값을 HTML 로 읽지 않는다)
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
    b.append(el('b', '', [r.ourref, r.yourref].filter(Boolean).join(' / ') || '-'), el('span', '', [r.n_app, r.applicant, r.title].filter(Boolean).join(' · ')));
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
  $('op-sub').textContent = [c.div, c.applicant, c.title_kor].filter(Boolean).join(' · ');
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
  for (const b of tabsEl.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  foot.hidden = tab !== 'wrapper';
  const my = ++seq;
  const c = current.case;
  try {
    if (tab === 'info') {
      main.replaceChildren(infoGrid(c), el('h3', 'op-h', '업무배분'), el('p', 'op-msg', '불러오는 중…'));
      const rows = await load('mywork', api.mywork);
      if (my !== seq) return;
      main.lastChild.replaceWith(table([
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

let attach = [];
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
      b.value = String(r.n);
      b.setAttribute('aria-label', `${r.name} 고르기`);
      b.addEventListener('change', sync);
      boxes.push(b);
      return b;
    }, 'chk'],
    ['No.', (r) => String(r.n), 'num'],
    ['등록일', (r) => r.date],
    ['문서명', (r) => r.doc],
    ['파일명', (r) => r.name],
    ['크기', (r) => r.size, 'num'],
  ], attach, { empty: '받을 수 있는 전자포대 파일이 없어요' });
  all.addEventListener('change', () => {
    for (const b of boxes) b.checked = all.checked;
    sync();
  });
  // 줄을 눌러도 고르기
  t.querySelector('tbody')?.addEventListener('click', (e) => {
    if (e.target.closest('input')) return;
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
  const getSome = el('button', 'op-btn', '고른 것 받기');
  getSome.type = 'button';
  const getAll = el('button', 'op-btn primary', `전체 받기 (${attach.length})`);
  getAll.type = 'button';
  getAll.disabled = !attach.length;
  foot.replaceChildren(el('span', 'op-label', '저장 위치'), dir, change, status, getSome, getAll);

  function sync() {
    const n = boxes.filter((b) => b.checked).length;
    all.checked = n > 0 && n === boxes.length;
    all.indeterminate = n > 0 && n < boxes.length;
    getSome.textContent = n ? `고른 ${n}개 받기` : '고른 것 받기';
    getSome.disabled = !n;
  }
  sync();

  async function run(isAll) {
    const ns = boxes.filter((b) => b.checked).map((b) => Number(b.value));
    getSome.disabled = getAll.disabled = true;
    status.className = 'op-status';
    status.textContent = '받는 중…';
    try {
      const res = await api.download({ idx: current.case.idx, ns, all: isAll });
      const parts = [`${res.saved}개 저장`];
      if (res.skipped) parts.push(`${res.skipped}개는 이미 있음`);
      if (res.failed.length) parts.push(`${res.failed.length}개 실패`);
      status.className = `op-status ${res.failed.length ? 'err' : 'ok'}`;
      status.textContent = `${res.failed.length ? '' : '✓ '}${parts.join(' · ')}${isAll ? ' · 사건정보.txt' : ''}`;
      status.title = res.failed.map((f) => `${f.name}: ${f.error}`).join('\n');
      foot.querySelector('.op-open')?.remove();
      const openBtn = el('button', 'op-link op-open', '폴더 열기');
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => api.openFolder());
      status.after(openBtn);
    } catch (err) {
      status.className = 'op-status err';
      status.textContent = errText(err);
    } finally {
      getAll.disabled = !attach.length;
      sync();
    }
  }
  getSome.addEventListener('click', () => run(false));
  getAll.addEventListener('click', () => run(true));
}

api.onProgress((p) => {
  const s = foot.querySelector('.op-status');
  if (s && p.total && p.i < p.total) s.textContent = `받는 중… ${p.i + 1}/${p.total} · ${p.name}`;
});

api.onShow(({ idx, tab: which }) => {
  if (idx) open(idx, which || 'info');
  else input.focus();
});
input.focus();
