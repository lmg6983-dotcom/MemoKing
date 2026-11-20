// preload.cjs(Electron 판에서 가져온 것)를 그대로 돌린다: require('electron') 자리에 Tauri 를 넣는다.
//   화면(app/)은 Electron 때와 똑같은 window.memoking 을 본다. 채널 이름도 그대로 → Rust 의 ipc::dispatch 가 받는다.
(() => {
  const tauri = () => window.__TAURI_INTERNALS__;
  const asError = (e) => (e instanceof Error ? e : new Error(String(e)));
  // 바이트(그림 · 파일)는 JSON 으로 보내면 {"0":…} 꼴로 몇 배 커진다 — { $bytes: base64 } 로 감싸 주고받는다 (Rust ipc.rs bytes)
  const toB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const wrap = (a) => (a instanceof ArrayBuffer ? { $bytes: toB64(new Uint8Array(a)) } : ArrayBuffer.isView(a) ? { $bytes: toB64(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)) } : a);
  const unwrap = (v) => (v && typeof v === 'object' && typeof v.$bytes === 'string' ? Uint8Array.from(atob(v.$bytes), (c) => c.charCodeAt(0)) : v);
  const call = (channel, args) => tauri().invoke('ipc', { channel, args: args.map(wrap) }).then(unwrap, (e) => { throw asError(e); });
  // Windows(WebView2)는 사용자 프로토콜을 http://<이름>.localhost 로 바꿔 부른다
  const scheme = (name) => (navigator.userAgent.includes('Windows') ? `http://${name}.localhost/` : `${name}://localhost/`);
  const unlisten = new Map(); // handler → Promise<끄기>

  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { window[name] = api; } },
    ipcRenderer: {
      invoke: (channel, ...args) => call(channel, args),
      send: (channel, ...args) => { call(channel, args).catch((e) => console.warn(`[ipc] ${channel}`, e)); },
      // 창을 닫는 순간의 저장처럼 기다릴 수 없는 일 — 동기 XHR 로 Rust 를 바로 부른다 (memoking 프로토콜의 sync/, CSP 는 note.html 이 허용)
      sendSync: (channel, ...args) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${scheme('memoking')}sync/${channel}`, false);
        xhr.send(JSON.stringify(args));
        const r = JSON.parse(xhr.responseText || '{}');
        if (r.err) throw new Error(r.err);
        return r.v ?? null;
      },
      on: (channel, handler) => {
        const win = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
        // Tauri 는 한 이벤트의 받는 함수들을 차례로 부른다 — 하나가 던지면 뒤 것이 못 받으니 저마다 가둔다 (Electron 처럼)
        const deliver = (e) => {
          try {
            handler({}, ...(Array.isArray(e.payload) ? e.payload : [e.payload]));
          } catch (err) {
            console.error(`[이벤트] ${channel}`, err);
          }
        };
        unlisten.set(handler, win.listen(channel, deliver));
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

  // 화면에서 난 잡히지 않은 오류를 오류 기록에 (설정 › 문제 보내기) — Electron 은 메인이 창의 오류를 받아 적었다. 창마다 20줄까지
  let logged = 0;
  const logError = (text) => {
    if (++logged > 20) return;
    call('app:log-error', [String(text).slice(0, 800)]).catch(() => {});
  };
  window.addEventListener('error', (e) => logError(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno}:${e.colno})`));
  window.addEventListener('unhandledrejection', (e) => logError(`처리 안 된 거부: ${e.reason?.stack || e.reason?.message || e.reason}`));

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
      // 목록 창 CSP 는 style-src 'self' — <style> 대신 CSSOM 시트로
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`
        .mk-caption { position: fixed; top: 0; right: 0; height: 44px; display: flex; z-index: 102; -webkit-app-region: no-drag; }
        .mk-caption button { width: 46px; height: 100%; border: 0; background: transparent; color: inherit; font: 10px 'Segoe Fluent Icons', 'Segoe MDL2 Assets'; }
        .mk-caption button:hover { background: rgba(127, 127, 127, 0.18); }
        .mk-caption button.close:hover { background: #c42b1c; color: #fff; }`);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      bar.innerHTML = `
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

  // 메모 편집기의 오른쪽 클릭: Electron 은 메인이 그린 메뉴에 "서식 지우기" 가 있었다 (desktop/context-menu.js) — WebView2 기본 메뉴에는 없어
  //   같은 항목을 Rust 가 띄우는 메뉴(menu:choose)로. 표 · 그림 위처럼 화면이 따로 메뉴를 띄우는 곳(block-move.js)은 먼저 막혀 여기 오지 않는다
  //   shortcut: 맞춤법 후보 · 사전에 추가는 빠진다 — 아쉽다는 말이 나오면 WebView2 ContextMenuRequested 로 기본 메뉴에 더하기
  if (location.pathname.endsWith('/note.html')) {
    window.addEventListener('contextmenu', async (e) => {
      if (e.defaultPrevented || !(e.target instanceof Element) || !e.target.closest('[contenteditable="true"]')) return;
      e.preventDefault();
      const picked = !getSelection().isCollapsed;
      const id = await call('menu:choose', [[
        { id: 'cut', label: '잘라내기', accelerator: 'CmdOrCtrl+X', enabled: picked },
        { id: 'copy', label: '복사', accelerator: 'CmdOrCtrl+C', enabled: picked },
        { id: 'paste', label: '붙여넣기', accelerator: 'CmdOrCtrl+V' },
        { id: 'pastePlain', label: '서식 없이 붙여넣기', accelerator: 'CmdOrCtrl+Shift+V' },
        { type: 'separator' },
        { id: 'clearFormat', label: '서식 지우기', accelerator: 'CmdOrCtrl+\\' },
        { type: 'separator' },
        { id: 'selectAll', label: '모두 선택', accelerator: 'CmdOrCtrl+A' },
      ], { x: e.clientX, y: e.clientY }]).catch(() => null);
      if (id === 'selectAll') document.execCommand('selectAll');
      else if (id) call('edit:run', [id]);
    });
  }

  window.memoking.vaultBase =`${scheme('memoking')}vault/`;
  window.memoking.historyBase = `${scheme('memoking')}history/`;
  window.memoking.posterBase = `${scheme('memoking')}poster/`; // 동영상 첫 장면은 메인이 ffmpeg 로 (video.rs poster)
})();
