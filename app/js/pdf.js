// PDF 만들기 창 — 크기·비율·방향·여백을 고르면 미리보기가 바로 바뀌고, 저장하면 메인 프로세스가 PDF 를 만든다.
import { PAPERS, RATIOS, MARGINS, pageSize, keepRatio, ratioLabel, mmToPx, clampPrintScale } from './core/pdf-page.js';
import { attachSliders } from './seg-slider.js';
import { flipFrom, radioGroups } from './dom.js';

const api = window.memoking;
const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');
const STORE = 'memoking.pdf';

// 고른 것 (지난번 고른 것을 기억)
let opt = { kind: 'paper', paper: 'a4', orientation: 'portrait', ratio: '4:3', long: 150, width: 100, height: 150, margin: 'normal', bg: false, date: true, open: true, zoom: 100 };
try {
  opt = { ...opt, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') };
} catch {
  // 처음
}
const remember = () => {
  try {
    localStorage.setItem(STORE, JSON.stringify(opt));
  } catch {
    // 저장 못 해도 괜찮음
  }
};

function chip(group, value, label, checked) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.dataset[group] = value;
  b.setAttribute('aria-checked', String(checked));
  b.textContent = label;
  return b;
}

function radios(container, attr, value) {
  for (const b of container.querySelectorAll(`[data-${attr}]`)) b.setAttribute('aria-checked', String(b.dataset[attr] === value));
}

const size = () => pageSize(opt);

let frameTimer = 0;
let view = { pw: 0, ph: 0, scale: 1 }; // 지금 미리보기: 쪽 크기(px)와 줄인 비율
function render() {
  radios($('kind'), 'kind', opt.kind);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== opt.kind;
  $('papers').replaceChildren(...PAPERS.map((p) => chip('paper', p.id, p.label, p.id === opt.paper)));
  $('ratios').replaceChildren(...RATIOS.map((r) => chip('ratio', r.id, r.label, r.id === opt.ratio)));
  radios($('orientation'), 'o', opt.orientation);
  radios($('margin'), 'm', opt.margin);
  const z = Number(opt.zoom);
  opt.zoom = z >= 50 && z <= 200 ? Math.round((clampPrintScale(z / 100) * 100) / 5) * 5 : 100; // 5% 단위 · 엉뚱한 값은 100%
  radios($('zoom'), 'z', String(opt.zoom)); // 직접 맞춘 값이 단계와 다르면 단계는 모두 꺼진다
  $('zoom-range').value = String(opt.zoom);
  $('zoom-out').textContent = `${opt.zoom}%`;
  $('long').value = String(opt.long);
  $('long-out').textContent = `${opt.long}mm`;
  $('cw').value = String(opt.width);
  $('ch').value = String(opt.height);
  $('bg').checked = opt.bg;
  $('date').checked = opt.date;
  $('open-after').checked = opt.open;
  const s = size();
  // 미리보기: 실제 크기 쪽을 그린 뒤 미리보기 칸에 맞게 줄인다
  const stage = $('stage').getBoundingClientRect();
  const pw = mmToPx(s.width);
  const ph = mmToPx(s.height);
  const scale = Math.min((stage.width - 32) / pw, (stage.height - 32) / ph);
  const sheet = $('sheet');
  const before = sheet.getBoundingClientRect();
  sheet.style.width = `${pw * scale}px`;
  sheet.style.height = `${ph * scale}px`;
  const frame = $('frame');
  frame.style.width = `${pw}px`;
  frame.style.height = `${ph}px`;
  frame.style.transform = `scale(${scale})`;
  flipFrom(sheet, before);
  sheet.classList.remove('multi');
  view = { pw, ph, scale };
  document.body.dataset.pages = '';
  $('summary').textContent = `${s.width} × ${s.height}mm (${ratioLabel(s.width, s.height)})`;
  // 쪽 내용은 잠깐 멈춘 뒤에 다시 그린다 (입력하는 동안 깜빡이지 않게)
  clearTimeout(frameTimer);
  frameTimer = setTimeout(() => {
    const src = `print.html?${new URLSearchParams({ id, w: s.width, h: s.height, m: MARGINS[opt.margin], bg: opt.bg ? 1 : 0, date: opt.date ? 1 : 0, z: opt.zoom / 100, preview: 1 })}`;
    if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
  }, 150);
  remember();
  requestAnimationFrame(() => showMore()); // 고르기 칸이 바뀌어 길이가 달라졌을 수 있다
}

window.addEventListener('message', (e) => {
  if (e.data?.type !== 'pdf-preview') return;
  const s = size();
  const n = e.data.pages;
  document.body.dataset.pages = String(n);
  // 여러 쪽이면 쪽을 모두 위아래로 이어 보이고, 미리보기 칸은 스크롤 (첫 쪽 크기는 그대로)
  const { ph, scale } = view;
  const total = n > 1 ? n * ph + (n - 1) * (Number(e.data.gap) || 0) : ph;
  const sheet = $('sheet');
  const frame = $('frame');
  sheet.classList.toggle('multi', n > 1);
  sheet.style.height = `${total * scale}px`;
  frame.style.height = `${total}px`;
  frame.title = n > 1 ? `미리보기 ${n}쪽` : '미리보기';
  $('summary').textContent = `${s.width} × ${s.height}mm (${ratioLabel(s.width, s.height)}), ${n}쪽`;
});

$('kind').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  opt.kind = b.dataset.kind;
  render();
});
$('papers').addEventListener('click', (e) => {
  const b = e.target.closest('[data-paper]');
  if (!b) return;
  opt.paper = b.dataset.paper;
  render();
});
$('ratios').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ratio]');
  if (!b) return;
  opt.ratio = b.dataset.ratio;
  render();
});
$('orientation').addEventListener('click', (e) => {
  const b = e.target.closest('[data-o]');
  if (!b) return;
  opt.orientation = b.dataset.o;
  render();
});
$('margin').addEventListener('click', (e) => {
  const b = e.target.closest('[data-m]');
  if (!b) return;
  opt.margin = b.dataset.m;
  render();
});
$('zoom').addEventListener('click', (e) => {
  const b = e.target.closest('[data-z]');
  if (!b) return;
  opt.zoom = Number(b.dataset.z);
  render();
});
$('zoom-range').addEventListener('input', (e) => {
  opt.zoom = Number(e.target.value);
  render();
});
$('long').addEventListener('input', (e) => {
  opt.long = Number(e.target.value);
  render();
});
for (const [el, side] of [[$('cw'), 'width'], [$('ch'), 'height']]) {
  el.addEventListener('change', () => {
    const v = Number(el.value);
    if ($('lock').checked) Object.assign(opt, keepRatio(side, v, { width: opt.width, height: opt.height }));
    else opt[side] = pageSize({ kind: 'custom', width: side === 'width' ? v : opt.width, height: side === 'height' ? v : opt.height })[side];
    render();
  });
}
$('bg').addEventListener('change', (e) => {
  opt.bg = e.target.checked;
  render();
});
$('date').addEventListener('change', (e) => {
  opt.date = e.target.checked;
  render();
});
$('open-after').addEventListener('change', (e) => {
  opt.open = e.target.checked;
  remember();
});
$('cancel').addEventListener('click', () => window.close());
// 창이 작아 고르기가 단추 줄 밑에 숨으면 알려 준다
const form = $('form');
function showMore() {
  const more = form.scrollHeight - form.scrollTop - form.clientHeight > 4;
  document.querySelector('.actions').classList.toggle('more', more);
  $('more-hint').hidden = !more || form.scrollTop > 0;
}
form.addEventListener('scroll', showMore, { passive: true });
new ResizeObserver(showMore).observe(form);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});
let stageSize = '';
let stageFrame = 0;
new ResizeObserver(() => {
  if (stageFrame) return;
  stageFrame = requestAnimationFrame(() => {
    stageFrame = 0;
    const r = $('stage').getBoundingClientRect();
    const key = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (key !== stageSize) {
      stageSize = key;
      render();
    }
  });
}).observe($('stage'));

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = size();
  $('save').disabled = true;
  $('status').textContent = 'PDF를 만드는 중…';
  $('status').classList.remove('error');
  const r = await api.pdf.save(id, { width: s.width, height: s.height, margin: MARGINS[opt.margin], bg: opt.bg, date: opt.date, open: opt.open, zoom: opt.zoom / 100 }).catch(() => null);
  $('save').disabled = false;
  if (r?.file) {
    $('status').textContent = `${r.pages}쪽 PDF로 저장했어요`;
    setTimeout(() => window.close(), 900);
  } else if (r?.cancelled) {
    $('status').textContent = '';
  } else {
    $('status').textContent = 'PDF를 만들지 못했어요. 다른 위치에 저장해 보세요';
    $('status').classList.add('error');
  }
});

const memo = await api.pdf.memo(id);
$('heading').textContent = memo ? `"${memo.title}" PDF로 저장` : 'PDF로 저장';
render();
document.documentElement.dataset.ready = 'true';

attachSliders(document, '.seg'); // 고르기 칸: 선택 표시가 미끄러진다

// 고르기 칸(role=radiogroup): 칸마다 radio, 화살표로 고르기 (dom.js)
radioGroups();
