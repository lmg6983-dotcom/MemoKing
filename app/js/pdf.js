// PDF 만들기 창 — 크기·비율·방향·여백을 고르면 미리보기가 바로 바뀌고, 저장하면 메인 프로세스가 PDF 를 만든다.
import { PAPERS, RATIOS, MARGINS, pageSize, keepRatio, ratioLabel, mmToPx } from './core/pdf-page.js';

const api = window.memoking;
const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');
const STORE = 'memoking.pdf';

// 고른 것 (지난번 고른 것을 기억)
let opt = { kind: 'paper', paper: 'a4', orientation: 'portrait', ratio: '4:3', long: 150, width: 100, height: 150, margin: 'normal', bg: false, date: true, open: true };
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
function render() {
  radios($('kind'), 'kind', opt.kind);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== opt.kind;
  $('papers').replaceChildren(...PAPERS.map((p) => chip('paper', p.id, p.label, p.id === opt.paper)));
  $('ratios').replaceChildren(...RATIOS.map((r) => chip('ratio', r.id, r.label, r.id === opt.ratio)));
  radios($('orientation'), 'o', opt.orientation);
  radios($('margin'), 'm', opt.margin);
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
  sheet.style.width = `${pw * scale}px`;
  sheet.style.height = `${ph * scale}px`;
  const frame = $('frame');
  frame.style.width = `${pw}px`;
  frame.style.height = `${ph}px`;
  frame.style.transform = `scale(${scale})`;
  document.body.dataset.pages = '';
  $('summary').textContent = `${s.width} × ${s.height}mm · ${ratioLabel(s.width, s.height)}`;
  // 쪽 내용은 잠깐 멈춘 뒤에 다시 그린다 (입력하는 동안 깜빡이지 않게)
  clearTimeout(frameTimer);
  frameTimer = setTimeout(() => {
    const src = `print.html?${new URLSearchParams({ id, w: s.width, h: s.height, m: MARGINS[opt.margin], bg: opt.bg ? 1 : 0, date: opt.date ? 1 : 0, preview: 1 })}`;
    if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
  }, 150);
  remember();
}

window.addEventListener('message', (e) => {
  if (e.data?.type !== 'pdf-preview') return;
  const s = size();
  const n = e.data.pages;
  document.body.dataset.pages = String(n);
  $('summary').textContent = `${s.width} × ${s.height}mm · ${ratioLabel(s.width, s.height)} · ${n}쪽`;
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
  $('status').textContent = 'PDF를 만들고 있어요';
  $('status').classList.remove('error');
  const r = await api.pdf.save(id, { width: s.width, height: s.height, margin: MARGINS[opt.margin], bg: opt.bg, date: opt.date, open: opt.open }).catch(() => null);
  $('save').disabled = false;
  if (r?.file) {
    $('status').textContent = `${r.pages}쪽 PDF로 저장했어요`;
    setTimeout(() => window.close(), 900);
  } else if (r?.cancelled) {
    $('status').textContent = '';
  } else {
    $('status').textContent = 'PDF를 만들지 못했어요. 저장할 곳을 바꿔 다시 시도해 주세요.';
    $('status').classList.add('error');
  }
});

const memo = await api.pdf.memo(id);
$('heading').textContent = memo ? `"${memo.title}" PDF로 저장` : 'PDF로 저장';
render();
document.documentElement.dataset.ready = 'true';
