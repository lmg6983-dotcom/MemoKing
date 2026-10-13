// 잠깐 알림 (HUD) 창 — 메인이 보낸 글을 보여 주고, 사라지라고 하면 흐려진다 (window-manager.js showHud)
const api = window.memoking;
const hud = document.getElementById('hud');
const title = document.getElementById('hud-title');
const body = document.getElementById('hud-body');

api.on('hud:show', ({ title: t = '', body: b = '', kind = 'ok' } = {}) => {
  title.textContent = t;
  body.textContent = b;
  hud.classList.toggle('warn', kind === 'warn');
  hud.classList.remove('on');
  void hud.offsetWidth; // 다시 떠오르게
  hud.classList.add('on');
});
api.on('hud:hide', () => hud.classList.remove('on'));
