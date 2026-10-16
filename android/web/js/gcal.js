// Google 캘린더 상호 동기화 (휴대폰) — 엔진은 PC 와 같은 app/js/core/gcal-sync.js
//   요청은 앱(GoogleCalendarApi.kt)이 휴대폰 구글 계정의 캘린더 권한으로 대신 보낸다
//   상태 파일 _memoking/google-calendar.json 은 메모 폴더에 있어 Drive 로 PC 와 함께 쓴다 —
//   PC 메모킹이 맡고 있으면(20분 임대) 휴대폰은 쉬고, PC 가 꺼져 있으면 휴대폰이 이어받는다
//   언제: 앱을 열 때 · 일정이 바뀌고 몇 초 뒤 · 보고 있는 동안 5분마다 · "지금 맞추기"
import { GoogleCalendarSync, STATE_FILE } from '../../app/js/core/gcal-sync.js';
import { vaultMemos, createCalendarRunner } from '../../app/js/core/gcal-runner.js';
import { fs, call } from './native.js';
import { app } from './state.js';

const ON_KEY = 'memoking.gcal';
const DEVICE_KEY = 'memoking.gcalDevice';
const EVERY_MS = 5 * 60_000;

const ls = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // 다음에
    }
  },
};

function deviceId() {
  let id = ls.get(DEVICE_KEY);
  if (!id) {
    id = `phone:${Math.random().toString(36).slice(2, 10)}`;
    ls.set(DEVICE_KEY, id);
  }
  return id;
}

const listeners = new Set();
const connected = () => ls.get(ON_KEY) === '1';
let onChanged = () => {};

// 메모는 app.setReminders 로 (알림 다시 예약 · 그사이 바뀌었으면 오류)
const memos = vaultMemos({ getVault: () => app.vault, saveReminders: (id, list) => app.setReminders(id, list), onChanged: () => onChanged() });
const sync = new GoogleCalendarSync({
  device: deviceId(),
  memos,
  // 이 휴대폰에만: 이 휴대폰이 만든 캘린더 (PC 와 동시에 만들었으면 진 쪽을 지운다)
  local: {
    get: () => {
      try {
        return JSON.parse(ls.get('memoking.gcalMine') ?? 'null');
      } catch {
        return null;
      }
    },
    set: (v) => ls.set('memoking.gcalMine', v ? JSON.stringify(v) : null),
  },
  request: async (method, url, body) => {
    const res = await call('googleCalendar', { method, url, body: body ?? null });
    let json = null;
    try {
      json = res.text ? JSON.parse(res.text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  },
  store: {
    // 없으면 null(처음), 읽지 못하면 오류 (엔진이 이번엔 건너뛴다)
    read: () => {
      const text = fs.readText(STATE_FILE);
      return text == null ? null : JSON.parse(text); // 빈 파일(Drive 가 쓰는 중)은 오류로 — 처음으로 보지 않는다
    },
    write: (state) => {
      fs.mkdirs('_memoking');
      fs.writeText(STATE_FILE, JSON.stringify(state, null, 1));
    },
  },
});
const runner = createCalendarRunner({ sync, memos, connected, getVault: () => app.vault, onStatus: (info) => listeners.forEach((fn) => fn(info)) });

export const runCalendarSync = (opts) => runner.run(opts);
export const calendarSyncSoon = (ids) => runner.soon(ids);

/** 일정 탭(list-reminders.js · calendar-links.js)이 쓰는 모양 — PC 의 api.calendars.google 과 같다 */
export const googleCalendar = {
  status: async () => runner.info(),
  connect: async () => {
    const ok = await call('googleCalendarAuth');
    if (!ok) throw new Error('캘린더 권한을 허용하지 않았어요');
    ls.set(ON_KEY, '1');
    return runCalendarSync({ force: true });
  },
  cancel: async () => {},
  disconnect: async () => {
    ls.set(ON_KEY, null);
    return runner.forget();
  },
  sync: () => runCalendarSync({ force: true }),
  onStatus: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** 앱이 메모 폴더를 연 뒤 한 번: 열 때 · 보이는 동안 5분마다. 메모가 바뀌면 onChange (일정 탭 · 알림 새로) */
export function startCalendarSync({ onChange }) {
  onChanged = onChange;
  setTimeout(() => runCalendarSync(), 4000);
  setInterval(() => {
    if (!document.hidden) runCalendarSync();
  }, EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) runCalendarSync();
  });
}
