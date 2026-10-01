// 끌어다 놓기 미리보기 창 — 메인 프로세스가 위치를 옮기고, 여기서는 모양만 바꾼다.
const api = window.memoking;
const ghost = document.getElementById('ghost');

api.on('ghost:data', ({ color, title, preview, open }) => {
  ghost.dataset.color = color;
  ghost.classList.remove('visible', 'dropped');
  document.getElementById('ghost-title').textContent = title;
  document.getElementById('ghost-preview').textContent = preview;
  document.getElementById('ghost-label').textContent = open ? '놓으면 여기로 옮겨요' : '놓으면 여기에 열려요';
});

api.on('ghost:visible', (visible) => {
  if (!visible) {
    ghost.classList.remove('visible');
    return;
  }
  // 창이 나타난 다음 프레임에 클래스를 붙여야 커지며 등장하는 애니메이션이 보인다.
  ghost.classList.remove('visible');
  requestAnimationFrame(() => requestAnimationFrame(() => ghost.classList.add('visible')));
});

api.on('ghost:drop', () => ghost.classList.add('dropped'));

// 떠 있는 다른 메모 위: 합쳐질 것을 알린다
let normalLabel = '';
api.on('ghost:mode', ({ stack }) => {
  const label = document.getElementById('ghost-label');
  if (stack && !ghost.classList.contains('stacking')) normalLabel = label.textContent;
  ghost.classList.toggle('stacking', Boolean(stack));
  label.textContent = stack ? '놓으면 탭으로 합쳐요' : normalLabel || label.textContent;
});

document.documentElement.dataset.ready = 'true';
