// 화면(app/)이 쓸 수 있는 데스크탑 기능만 골라서 노출한다.
// 안드로이드 버전은 같은 모양의 window.memoking 을 Capacitor 로 구현하면 된다.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = [
  'memos:changed', 'memo:external', 'memo:removed', 'memo:meta', 'memo:links-changed', 'vault:indexed', 'vault:opened',
  'drag:state', 'ghost:data', 'ghost:visible', 'ghost:drop',
  'reminders:changed', 'memo:reminders', 'memo:alarm', 'history:changed', 'list:tab', 'memo:highlight',
  'stack:state', 'stack:hover', 'ghost:mode', 'tutorial:step', 'capture:image', 'memo:on-top', 'sticker:show', 'sticker:peel', 'list:on-top',
];
const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('memoking', {
  platform: 'desktop',
  info: invoke('app:info'),
  vault: {
    use: invoke('vault:use'),
    choose: invoke('vault:choose'),
    reveal: invoke('vault:reveal'),
    revealIndex: invoke('vault:reveal-index'),
  },
  memos: {
    list: invoke('memos:list'),
    search: invoke('memos:search'),
  },
  tags: {
    list: invoke('tags:list'),
  },
  memo: {
    open: invoke('memo:open'),
    create: invoke('memo:create'),
    get: invoke('memo:get'),
    save: invoke('memo:save'),
    // 창이 닫히는 순간에는 비동기 저장이 끝나기 전에 창이 사라질 수 있어 동기 저장을 쓴다.
    saveSync: (id, body) => ipcRenderer.sendSync('memo:save-sync', id, body),
    set: invoke('memo:set'),
    remove: invoke('memo:remove'),
    links: invoke('memo:links'),
    link: invoke('memo:link'),
  },
  // 예약 알림
  reminders: {
    set: invoke('reminders:set'),
    all: invoke('reminders:all'),
  },
  // 알림 보관함 (Windows 알림 기록)
  history: {
    list: invoke('history:list'),
    setEnabled: invoke('history:set-enabled'),
    setPopupWatch: invoke('history:set-popup-watch'),
    remove: invoke('history:remove'),
    clear: invoke('history:clear'),
    toMemo: invoke('history:to-memo'),
  },
  settings: {
    get: invoke('app:settings'),
    setAutoStart: invoke('app:set-auto-start'),
    setQuickMemo: invoke('app:set-quick-memo'),
    setTrashDays: invoke('app:set-trash-days'),
  },
  // 휴지통 (지운 메모)
  trash: {
    list: invoke('trash:list'),
    restore: invoke('trash:restore'),
    remove: invoke('trash:delete'),
    empty: invoke('trash:empty'),
  },
  copyText: invoke('clipboard:write-text'),
  // 목록 카드를 끌어 화면에 놓기 (좌표는 화면 기준)
  drag: {
    start: invoke('drag:start'),
    move: (x, y) => ipcRenderer.send('drag:move', { x, y }),
    end: (point) => ipcRenderer.invoke('drag:end', point ?? null),
  },
  attachments: {
    save: invoke('attachment:save'),
    open: invoke('attachment:open'),
    fetch: invoke('attachment:fetch'),
    info: invoke('attachment:info'),
  },
  // 링크 미리보기 카드
  links: {
    preview: invoke('link:preview'),
    open: invoke('link:open'),
  },
  // 메모를 PDF 로
  pdf: {
    open: invoke('pdf:open'),
    memo: invoke('pdf:memo'),
    save: invoke('pdf:save'),
  },
  // 왕관 스티커 창: 왕관 위 마우스, 눌러서 떼기
  sticker: {
    hover: (over) => ipcRenderer.send('sticker:hover', Boolean(over)),
    peel: invoke('sticker:peel'),
  },
  // 영역 캡처 오버레이 (Ctrl+Alt+C 두 번)
  capture: {
    done: invoke('capture:done'),
    cancel: invoke('capture:cancel'),
  },
  // 처음 실행 튜토리얼
  tutorial: {
    start: invoke('tutorial:start'),
    current: invoke('tutorial:current'),
    action: invoke('tutorial:action'),
    event: invoke('tutorial:event'),
  },
  // 메모 스택 (한 창의 탭)
  stack: {
    activate: invoke('stack:activate'),
    newTab: invoke('stack:new-tab'),
    remove: invoke('stack:remove'),
    detach: invoke('stack:detach'),
    tearStart: invoke('stack:tear-start'),
    tearMove: (x, y) => ipcRenderer.send('stack:tear-move', { x, y }),
    tearEnd: (x, y) => ipcRenderer.invoke('stack:tear-end', x == null ? null : { x, y }),
    cycle: invoke('stack:cycle'),
    menu: invoke('stack:menu'),
  },
  win: {
    close: invoke('win:close'),
    minimize: invoke('win:minimize'),
    dimTitlebar: invoke('win:dim-titlebar'),
    toggleListTop: invoke('list:toggle-top'),
    listOnTop: invoke('list:on-top'),
    toggleTop: invoke('win:toggle-top'),
    showList: invoke('list:show'),
  },
  on(event, callback) {
    if (!EVENTS.includes(event)) throw new Error(`알 수 없는 이벤트: ${event}`);
    const handler = (_e, ...args) => callback(...args);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.off(event, handler);
  },
});
