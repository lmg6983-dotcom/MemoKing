// 화면(app/)이 쓸 수 있는 데스크탑 기능만 골라서 노출한다.
// 안드로이드 버전은 같은 모양의 window.memoking 을 Capacitor 로 구현하면 된다.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = [
  'memos:changed', 'shortcuts:changed', 'memo:external', 'memo:removed', 'memo:trashed', 'memo:meta', 'memo:links-changed', 'vault:indexed', 'vault:opened',
  'drag:state', 'ghost:data', 'ghost:visible', 'ghost:drop',
  'reminders:changed', 'memo:reminders', 'memo:alarm', 'history:changed', 'list:tab', 'memo:highlight',
  'stack:state', 'stack:hover', 'memo:handoff', 'drive:status', 'ghost:mode', 'tutorial:step', 'capture:image', 'memo:on-top', 'sticker:show', 'sticker:peel', 'list:on-top',
  'stt:status', 'stt:line', 'stt:speaking', 'stt:speakers',
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
    auto: invoke('tags:auto'),
    suggest: invoke('tags:suggest'),
  },
  memo: {
    open: invoke('memo:open'),
    handoff: invoke('memo:handoff'), // 다른 기기에서 방금 고친 메모 { id, title, from } | null
    // 잠금 메모: lock(id, 비밀번호) · openLock(id, 비밀번호) → 메모 | { error } · unlock(id) 잠금 풀기
    lock: invoke('memo:lock'),
    openLock: invoke('memo:open-lock'),
    unlock: invoke('memo:unlock'),
    create: invoke('memo:create'),
    import: invoke('memo:import'), // (본문, { open }) → 메모 id
    get: invoke('memo:get'),
    save: invoke('memo:save'),
    keepCopy: invoke('memo:keep-copy'),
    // 창이 닫히는 순간에는 비동기 저장이 끝나기 전에 창이 사라질 수 있어 동기 저장을 쓴다.
    saveSync: (id, body) => ipcRenderer.sendSync('memo:save-sync', id, body),
    set: invoke('memo:set'),
    remove: invoke('memo:remove'),
    links: invoke('memo:links'),
    link: invoke('memo:link'),
    versions: invoke('memo:versions'),
    version: invoke('memo:version'),
    restoreVersion: invoke('memo:restore-version'),
  },
  // 예약 알림
  reminders: {
    set: invoke('reminders:set'),
    all: invoke('reminders:all'),
    add: invoke('reminders:add'),
  },
  // 알림 보관함 (Windows 알림 기록)
  history: {
    list: invoke('history:list'),
    setEnabled: invoke('history:set-enabled'),
    remove: invoke('history:remove'),
    clear: invoke('history:clear'),
    toMemo: invoke('history:to-memo'),
    // 앱마다 모으지 않기
    apps: invoke('history:apps'),
    blockApp: invoke('history:block'),
    unblockApp: invoke('history:unblock'),
  },
  // Google Drive 직접 동기화 (Google Drive 데스크탑 앱 없이)
  drive: {
    status: invoke('drive:status'),
    setClient: invoke('drive:set-client'),
    login: invoke('drive:login'),
    cancelLogin: invoke('drive:cancel-login'),
    folders: invoke('drive:folders'),
    createFolder: invoke('drive:create-folder'),
    use: invoke('drive:use'),
    auto: invoke('drive:auto'),
    sync: invoke('drive:sync'),
    disconnect: invoke('drive:disconnect'),
  },
  settings: {
    get: invoke('app:settings'),
    setAutoStart: invoke('app:set-auto-start'),
    setQuickMemo: invoke('app:set-quick-memo'),
    setFitTables: invoke('app:set-fit-tables'),
    setAutoTags: invoke('app:set-auto-tags'),
    setMagic: invoke('app:set-magic'),
    setTrashDays: invoke('app:set-trash-days'),
    // 전역 단축키 바꾸기: set(이름, 단축키|null=기본값) · pause(true) 는 새 키를 누르는 동안 잠시 놓기
    setShortcut: invoke('shortcuts:set'),
    pauseShortcuts: invoke('shortcuts:pause'),
  },
  // AI 비서 연결 (MCP): connect(true|false) · copy() 다른 AI 앱용 설정 글 복사 · setWrite(켜기)
  mcp: {
    connect: invoke('mcp:connect'),
    copy: invoke('mcp:copy'),
    setWrite: invoke('mcp:set-write'),
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
  // 받아쓰기 (PC): 데이터 받기 · 녹음하며 받아쓰기 · 소리 파일 받아쓰기
  stt: {
    status: invoke('stt:status'),
    download: invoke('stt:download'),
    remove: invoke('stt:remove'),
    setOptions: invoke('stt:options'),
    start: invoke('stt:start'),
    audio: (id, samples) => ipcRenderer.send('stt:audio', id, samples),
    stop: invoke('stt:stop'),
    transcribe: invoke('stt:transcribe'),
  },
  attachments: {
    save: invoke('attachment:save'),
    read: invoke('attachment:read'),
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
  // 메모를 그림 카드로: copy(base64) · save(메모 id, base64) → { file, name } | { cancelled }
  image: {
    copy: invoke('image:copy'),
    save: invoke('image:save'),
  },
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
    joinMenu: invoke('stack:join-menu'),
    menu: invoke('stack:menu'),
  },
  win: {
    close: invoke('win:close'),
    minimize: invoke('win:minimize'),
    dimTitlebar: invoke('win:dim-titlebar'),
    toggleListTop: invoke('list:toggle-top'),
    listOnTop: invoke('list:on-top'),
    toggleTop: invoke('win:toggle-top'),
    inking: invoke('win:inking'),
    showList: invoke('list:show'),
    growWidth: invoke('win:grow-width'),
  },
  on(event, callback) {
    if (!EVENTS.includes(event)) throw new Error(`알 수 없는 이벤트: ${event}`);
    const handler = (_e, ...args) => callback(...args);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.off(event, handler);
  },
});
