// 화면(app/)이 쓸 수 있는 데스크탑 기능만 골라서 노출한다.
// 안드로이드 버전은 같은 모양의 window.memoking 을 Capacitor 로 구현하면 된다.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = [
  'memos:changed', 'shortcuts:changed', 'memo:external', 'memo:removed', 'memo:trashed', 'memo:meta', 'memo:links-changed', 'vault:indexed', 'vault:opened',
  'drag:state', 'ghost:data', 'ghost:visible', 'ghost:drop',
  'reminders:changed', 'memo:reminders', 'memo:alarm', 'history:changed', 'list:tab', 'memo:highlight',
  'stack:state', 'stack:hover', 'memo:handoff', 'drive:status', 'ghost:mode', 'tutorial:step', 'capture:image', 'memo:layer', 'sticker:show', 'sticker:peel', 'sticker:hover', 'list:on-top',
  'stt:status', 'stt:line', 'stt:speaking', 'stt:speakers', 'hud:show', 'hud:hide', 'settings:link-previews', 'keymap:changed', 'stack:activating', 'stack:leaving', 'update:state', 'update:available', 'update:ready', 'mode:changed',
  'bubble:show', 'bubble:hide', 'status-bubble:gone', 'memo:command', 'card:trash', 'card:copied', 'edit:paste-plain', 'edit:clear-format',
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
    cardCommand: invoke('card:command'), // 목록 카드 메뉴: 메모 창에서 하는 일 (lock · unlock · versions)
    copyText: invoke('card:copy'), // 목록 카드 메뉴: 글 복사
    shareFile: invoke('card:share-file'), // 목록 카드 메뉴: 공유할 파일 { base64, name, mime } | { error }
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
  // 일정 탭이 함께 보는 다른 캘린더 (.ics 구독 — Google 캘린더 비공개 주소 등): feeds() · setFeeds(목록) · fetch(id, 새로) → { text, at, error? }
  calendars: {
    feeds: invoke('calendars:feeds'),
    setFeeds: invoke('calendars:set-feeds'),
    fetch: invoke('calendars:fetch'),
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
    setFullScope: invoke('drive:full-scope'),
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
    setLinkPreviews: invoke('app:set-link-previews'),
    setMagic: invoke('app:set-magic'),
    setTrashDays: invoke('app:set-trash-days'),
    // 전역 단축키 바꾸기: set(이름, 단축키|null=기본값) · pause(true) 는 새 키를 누르는 동안 잠시 놓기
    setShortcut: invoke('shortcuts:set'),
    pauseShortcuts: invoke('shortcuts:pause'),
  },
  // 자동 업데이트: state() · check() 지금 확인 · download() 받기 · later() 나중에(24시간 숨김 · 받아 뒀으면 끝낼 때 설치) · install() 지금 재시작
  update: {
    state: invoke('update:state'),
    check: invoke('update:check'),
    download: invoke('update:download'),
    later: invoke('update:later'),
    install: invoke('update:install'),
  },
  // OPMS 연결 설정: settings() → { host, wrapperDir, hostSet } · setHost(주소 | '' 지우기) → { ok, host } | { error } · chooseDir() → 폴더
  opms: {
    settings: invoke('opms:settings'),
    setHost: invoke('opms:set-host'),
    chooseDir: invoke('opms:choose-dir'),
  },
  // 메모 창 단축키: get() → { overrides, shortcuts } · set(기능, 키 | '' 없음 | null 기본값) · reset() 모두 처음대로 · openWindow() 설정 창
  keymap: {
    get: invoke('keymap:get'),
    set: invoke('keymap:set'),
    reset: invoke('keymap:reset'),
    openWindow: invoke('keymap:open-window'),
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

  copyMemoText: invoke('memo:copy-text'), // 메모 본문을 서식 기호 없이 클립보드에 → true | false
  // 메모 단축키 (Ctrl+Alt+1~9): state(메모 id) · set(메모 id, 칸|null, { copy, show }) → { ok, error?, state }
  hotkeys: {
    state: invoke('hotkey:state'),
    set: invoke('hotkey:set'),
  },
  copyText: invoke('clipboard:write-text'),
  copyRich: invoke('clipboard:write-rich'), // { text, html }
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
  },
  attachments: {
    save: invoke('attachment:save'),
    read: invoke('attachment:read'),
    open: invoke('attachment:open'),
    fetch: invoke('attachment:fetch'),
    info: invoke('attachment:info'),
    copy: invoke('attachment:copy'), // 메모 폴더의 첨부를 파일 그대로 클립보드에 → true | false
    // 내용 저장(저장 단추): { name, mime, rel? | base64? } → { name } | { cancelled } | { error }
    saveAs: invoke('attachment:save-as'),
    // 공유: { name, mime, rel? | base64?, via: 'drive' | 'localsend' | 'mail' } → { ok, link? } | { missing } | { error }
    share: invoke('attachment:share'),
    shareTargets: invoke('share:targets'),
    // 메모 안 내용을 탐색기 · 바탕화면 · 카카오톡 같은 다른 프로그램으로 끌어내기: { name, rel? | base64? } (끌기를 시작할 때 한 번)
    dragOut: (payload) => ipcRenderer.send('attachment:drag-out', payload),
    // 끌어다 놓은 파일의 원래 자리 — 메모킹이 끌어낸 임시 파일이 도로 떨어졌는지 알아보려고 (없으면 '')
    pathOf: (file) => {
      try {
        return webUtils.getPathForFile(file) || '';
      } catch {
        return '';
      }
    },
  },
  // 링크 미리보기 카드
  links: {
    preview: invoke('link:preview'),
    open: invoke('link:open'),
  },
  // 메모를 PDF 로
  // 메모를 그림 카드로: copy(base64) · save(메모 id, base64) → { file, name } | { cancelled }
  // 메모킹 Work / Life: 지금 모드 정하기 (읽기는 settings.get().mode)
  mode: { set: invoke('mode:set') },
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
    reorder: invoke('stack:reorder'), // 탭을 끌어 순서 바꾸기 (id, 새 자리)
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
  // 편집 명령을 이 창의 글 칸에 (잘라내기 · 복사 · 붙여넣기 · 서식 없이 붙여넣기) — 화면이 그린 메뉴(표 오른쪽 클릭)에서
  edit: {
    run: invoke('edit:run'),
  },
  // 화면이 정한 오른쪽 클릭 메뉴 (알림 보관함 줄) → 고른 id | null
  menu: {
    choose: invoke('menu:choose'),
  },
  win: {
    close: invoke('win:close'),
    minimize: invoke('win:minimize'),
    dimTitlebar: invoke('win:dim-titlebar'),
    toggleListTop: invoke('list:toggle-top'),
    listOnTop: invoke('list:on-top'),
    // 왕관(늘 위) · 테이프(바탕화면 층) 켜고 끄기 → { top, bottom, canTape }
    toggleLayer: invoke('win:toggle-layer'),
    statusBubble: invoke('win:status-bubble'), // { text, error, x } | null — 잘린 상태 줄의 전문 말풍선
    inking: invoke('win:inking'),
    showList: invoke('list:show'),
    growWidth: invoke('win:grow-width'),
    // 미리 불러 둔 예비 메모 창: 열 메모를 기다림 → { id, record, ink } | null · 그 메모를 그렸다고 알림
    spare: invoke('win:spare'),
    painted: () => ipcRenderer.send('win:painted'),
  },
  on(event, callback) {
    if (!EVENTS.includes(event)) throw new Error(`알 수 없는 이벤트: ${event}`);
    const handler = (_e, ...args) => callback(...args);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.off(event, handler);
  },
});
