// 앱(Kotlin)과 주고받기 — window.MemoKingNative (android/app/.../Bridge.kt)
//   바로 답하는 함수: {"v": 값} | {"err": "이유"} 글자 → 값 또는 예외
//   오래 걸리는 일: call(이름, 인자) → Promise (앱이 __mk.resolve 로 알려 줌)
//   앱이 보내는 소식: on('intent' | 'alarm' | 'app' | 'keyboard' | 'record' | 'transcribe' | 'widget', fn)

const raw = window.MemoKingNative;
if (!raw) throw new Error('메모킹 앱 안에서 열어 주세요 (MemoKingNative 없음)');

function unwrap(json) {
  const r = JSON.parse(json);
  if (r && typeof r === 'object' && 'err' in r) throw new Error(r.err);
  return r?.v ?? null;
}

const sync = (name) => (...args) => unwrap(raw[name](...args));

// 튜토리얼 연습 공간: 화면은 앱 안의 빈 폴더(예시 메모)를 쓰고, 실제 메모 폴더는 그대로 둔다 (Bridge.kt sandbox)
//   그동안 알림 예약 · 홈 화면 위젯 · Drive 동기화는 실제 메모 것 그대로 (연습 메모로 덮어쓰지 않게)
let sandboxOn = false;
export function setSandbox(on) {
  if (typeof raw.sandbox !== 'function') throw new Error('연습 공간을 쓸 수 없는 앱이에요');
  unwrap(raw.sandbox(Boolean(on)));
  sandboxOn = Boolean(on);
}
// 화면을 새로 띄우면(앱이 화면만 다시 만든 때 등) 연습 공간은 늘 꺼진 채로 — 실제 메모를 연습 폴더에 쓰지 않게
try {
  if (typeof raw.sandbox === 'function') unwrap(raw.sandbox(false));
} catch {
  // 다음에 켤 때 비운다
}
const outside = (fn) => (...args) => (sandboxOn ? null : fn(...args));

export const fs = {
  scan: sync('scan'),
  list: sync('list'),
  stat: sync('stat'),
  readText: sync('readText'),
  writeText: sync('writeText'),
  writeBase64: sync('writeBase64'),
  mkdirs: sync('mkdirs'),
  move: sync('move'),
  remove: sync('remove'),
  commitTemp: sync('commitTemp'),
  readTempText: sync('readTempText'),
  dropTemp: sync('dropTemp'),
};

export const native = {
  info: sync('info'),
  useInternalVault: sync('useInternalVault'),
  copyText: sync('copyText'),
  setChrome: sync('setChrome'),
  setHandwriting: sync('setHandwriting'),
  showKeyboard: sync('showKeyboard'),
  takeIntent: sync('takeIntent'),
  ready: sync('ready'),
  scheduleAlarms: outside((items) => unwrap(raw.scheduleAlarms(JSON.stringify(items)))),
  wasFired: sync('wasFired'),
  notify: (item) => unwrap(raw.notify(JSON.stringify(item))),
  sttStatus: sync('sttStatus'), // 받아쓰기 모델·엔진 상태
  openLiveUpdateSettings: sync('openLiveUpdateSettings'), // 녹음 중 상태 막대 캡슐(안드로이드 16 실시간 업데이트) 켜는 설정
  // 지난번 오류 기록 (앱이 멈췄거나 위젯에서 오류) — 꺼내면 지워짐. 예전 앱에는 없음
  lastError: () => (typeof raw.lastError === 'function' ? unwrap(raw.lastError()) : null),
};

// 홈 화면 위젯 (Widgets.kt)
export const widget = {
  memoIds: sync('widgetMemoIds'),
  publish: outside(sync('widgetPublish')),
  assign: outside(sync('widgetAssign')),
  pin: outside(sync('widgetPin')),
};

// 알림 보관함 (NotiService.kt)
export const history = {
  all: sync('historyAll'),
  setEnabled: sync('historySetEnabled'),
  remove: sync('historyRemove'),
  clear: sync('historyClear'),
  block: sync('historyBlock'),
  unblock: sync('historyUnblock'),
};

// 녹음 · 받아쓰기 (RecorderService.kt) — 시작·끝내기는 call('recordStart' | 'recordStop')
export const record = {
  status: sync('recordStatus'),
  pause: sync('recordPause'),
  resume: sync('recordResume'),
  takeDone: sync('recordTakeDone'), // 앱이 꺼져 있는 동안 끝난 녹음들
  ack: sync('recordAck'), // 메모에 넣었으니 지워도 됨
};

// Google Drive 동기화 (DriveSync.kt)
export const drive = {
  status: sync('driveStatus'),
  setClient: sync('driveSetClient'),
  disconnect: sync('driveDisconnect'),
  cancelLogin: sync('driveCancelLogin'),
  syncSoon: outside(sync('driveSyncSoon')),
};

const pending = new Map();
let seq = 0;

export function call(method, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    raw.call(id, method, JSON.stringify(args));
  });
}

const listeners = new Map();
export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}

let backHandler = () => false;
export function setBackHandler(fn) {
  backHandler = fn;
}

window.__mk = {
  resolve(id, json) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    try {
      p.resolve(unwrap(json));
    } catch (err) {
      p.reject(err);
    }
  },
  emit(name, data) {
    for (const fn of listeners.get(name) ?? []) {
      try {
        fn(data);
      } catch (err) {
        console.error(`[${name}]`, err);
      }
    }
  },
  // 뒤로 가기: 화면이 처리했으면 true (아니면 앱이 뒤로 감)
  back() {
    try {
      return Boolean(backHandler());
    } catch (err) {
      console.error(err);
      return false;
    }
  },
};

// Uint8Array → base64 (큰 파일도 스택이 넘치지 않게 나눠서) — 공용 core/base64.js
export { bytesBase64 as toBase64 } from '../../app/js/core/base64.js';
