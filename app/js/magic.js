// 매직키 창 — 입력한 글을 바로 메모로 (기본). 여러 기능 모듈로 늘릴 수 있고, 켜진 모듈은 아래 칩으로 보인다.
const api = window.magic;
const input = document.getElementById('magic-input');
const modulesEl = document.getElementById('magic-modules');
const hintEl = document.getElementById('magic-hint');

let modules = [];
async function loadModules() {
  modules = await api.modules().catch(() => []);
  modulesEl.replaceChildren(...modules.map((m) => {
    const chip = document.createElement('span');
    chip.className = 'magic-chip on';
    chip.textContent = m.name;
    chip.title = m.description;
    return chip;
  }));
  hintEl.textContent = modules.some((m) => m.id === 'memo') ? 'Enter 저장 · Ctrl+Enter 저장하고 열기' : '켜진 기능이 없어요 (설정에서 켜 주세요)';
}

// 창이 다시 떠오를 때마다 비우고 포커스 (늘 떠 있다가 보였다 숨었다 한다)
function reset() {
  input.value = '';
  resize();
  loadModules();
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}
api.onShow(reset);

function resize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
}
input.addEventListener('input', resize);

async function submit({ open }) {
  const text = input.value;
  if (!text.trim()) {
    api.close();
    return;
  }
  // 지금은 메모 모듈만 (기본). 나중에 접두사·고른 모듈로 갈라 보낸다.
  const memo = modules.find((m) => m.id === 'memo');
  if (!memo) {
    api.close();
    return;
  }
  try {
    await api.run({ module: 'memo', text, open });
  } finally {
    input.value = '';
    api.close();
  }
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    api.close();
    return;
  }
  if (e.key === 'Enter') {
    if (e.shiftKey) return; // 줄바꿈
    e.preventDefault();
    submit({ open: e.ctrlKey || e.metaKey });
  }
});

reset();
