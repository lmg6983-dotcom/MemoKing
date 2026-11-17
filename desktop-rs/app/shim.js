// Electron 의 desktop/preload.cjs 를 고치지 않고 그대로 돌린다: require('electron') 자리에 Tauri 를 넣는다.
//   화면(app/)은 Electron 때와 똑같은 window.memoking 을 본다. 채널 이름도 그대로 → Rust 의 ipc::dispatch 가 받는다.
(() => {
  const tauri = () => window.__TAURI_INTERNALS__;
  const asError = (e) => (e instanceof Error ? e : new Error(String(e)));
  const call = (channel, args) => tauri().invoke('ipc', { channel, args }).catch((e) => { throw asError(e); });
  // Windows(WebView2)는 사용자 프로토콜을 http://<이름>.localhost 로 바꿔 부른다
  const scheme = (name) => (navigator.userAgent.includes('Windows') ? `http://${name}.localhost/` : `${name}://localhost/`);
  const unlisten = new Map(); // handler → Promise<끄기>

  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { window[name] = api; } },
    // shortcut: 끌어다 놓은 파일의 원래 경로는 아직 '' (화면은 '' 를 "모름" 으로 다룬다) — 첨부 끌어내기를 옮길 때 Tauri 드롭 이벤트로
    webUtils: { getPathForFile: () => '' },
    ipcRenderer: {
      invoke: (channel, ...args) => call(channel, args),
      send: (channel, ...args) => { call(channel, args).catch((e) => console.warn(`[ipc] ${channel}`, e)); },
      // 창을 닫는 순간의 저장처럼 기다릴 수 없는 일 — 동기 XHR 로 Rust 를 바로 부른다 (memoking-sync 프로토콜)
      sendSync: (channel, ...args) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${scheme('memoking-sync')}${channel}`, false);
        xhr.send(JSON.stringify(args));
        const r = JSON.parse(xhr.responseText || '{}');
        if (r.err) throw new Error(r.err);
        return r.v ?? null;
      },
      on: (channel, handler) => {
        const win = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
        unlisten.set(handler, win.listen(channel, (e) => handler({}, ...(Array.isArray(e.payload) ? e.payload : [e.payload]))));
      },
      off: (_channel, handler) => {
        unlisten.get(handler)?.then((stop) => stop());
        unlisten.delete(handler);
      },
    },
  };
  // eslint-disable-next-line no-unused-vars
  const require = (name) => {
    if (name === 'electron') return electron;
    throw new Error(`preload 에서 쓸 수 없는 모듈: ${name}`);
  };

  /*PRELOAD*/

  // CSS 의 -webkit-app-region: drag 는 Electron 만 알아듣는다 — 그 자리를 누르면 Tauri 로 창을 끈다 (no-drag 가 가까우면 그대로)
  //   shortcut: ::before 같은 가상 요소에 단 drag(회상 앨범 머리줄)는 못 본다 — 그 화면을 옮길 때 실제 요소로
  const regionOf = (el) => { const s = getComputedStyle(el); return s.webkitAppRegion || s.appRegion || ''; };
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    for (let el = e.target; el instanceof Element; el = el.parentElement) {
      const region = regionOf(el);
      if (region === 'no-drag') return;
      if (region === 'drag') {
        e.preventDefault();
        if (e.detail === 2) tauri().invoke('plugin:window|toggle_maximize', { label: tauri().metadata.currentWindow.label });
        else tauri().invoke('plugin:window|start_dragging', { label: tauri().metadata.currentWindow.label });
        return;
      }
    }
  }, true);

  // 목록 창의 창 단추(최소화 · 최대화 · 닫기): Electron 은 Windows 가 그려 줬다(titleBarOverlay). Tauri 에는 없어
  //   list.css 가 비워 둔 오른쪽 142px 에 화면이 그린다. 대화 상자 뒤 막이 덮으니 어둡게 맞추던 일(win:dim-titlebar)도 필요 없다
  if (tauri().metadata.currentWindow.label === 'list') {
    window.addEventListener('DOMContentLoaded', () => {
      const label = 'list';
      const bar = document.createElement('div');
      bar.className = 'mk-caption';
      bar.innerHTML = `<style>
        .mk-caption { position: fixed; top: 0; right: 0; height: 44px; display: flex; z-index: 102; -webkit-app-region: no-drag; }
        .mk-caption button { width: 46px; height: 100%; border: 0; background: transparent; color: inherit; font: 10px 'Segoe Fluent Icons', 'Segoe MDL2 Assets'; }
        .mk-caption button:hover { background: rgba(127, 127, 127, 0.18); }
        .mk-caption button.close:hover { background: #c42b1c; color: #fff; }
      </style>
      <button tabindex="-1" aria-label="최소화" data-cmd="minimize">&#xE921;</button>
      <button tabindex="-1" aria-label="최대화" data-cmd="toggle_maximize">&#xE922;</button>
      <button tabindex="-1" aria-label="닫기" class="close" data-cmd="close">&#xE8BB;</button>`;
      bar.addEventListener('click', (e) => {
        const cmd = e.target.closest('button')?.dataset.cmd;
        if (cmd) tauri().invoke(`plugin:window|${cmd}`, { label });
      });
      document.body.append(bar);
    });
  }

  window.memoking.vaultBase = `${scheme('memoking')}vault/`;
  window.memoking.historyBase = `${scheme('memoking')}history/`;
})();
