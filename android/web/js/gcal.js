// Google 캘린더 상호 동기화 (휴대폰) — 엔진은 PC 와 같은 app/js/core/gcal-sync.js
//   요청은 앱(GoogleCalendarApi.kt)이 휴대폰 구글 계정의 캘린더 권한으로 대신 보낸다
//   상태 파일 _memoking/google-calendar.json 은 메모 폴더에 있어 Drive 로 PC 와 함께 쓴다 —
//   PC 메모킹이 맡고 있으면(20분 임대) 휴대폰은 쉬고, PC 가 꺼져 있으면 휴대폰이 이어받는다
//   언제: 앱을 열 때 · 일정이 바뀌고 몇 초 뒤 · 보고 있는 동안 5분마다 · "지금 맞추기"
import { GoogleCalendarSync, STATE_FILE, shapeOfReminder, shapeHash, keyOf } from '../../app/js/core/gcal-sync.js';
import { normalizeReminder } from '../../app/js/core/reminders.js';
import { fs, call } from './native.js';
import { app } from './state.js';

const ON_KEY = 'memoking.gcal';
const DEVICE_KEY = 'memoking.gcalDevice';
const EVERY_MS = 5 * 60_000;
const AFTER_CHANGE_MS = 8_000;

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

let status = { lastSync: 0, error: '', running: false, holder: '', calendarId: '', last: null };
const listeners = new Set();
const emit = () => {
  for (const fn of listeners) fn(info());
};
const connected = () => ls.get(ON_KEY) === '1';
const info = () => ({ ...status, connected: connected(), configured: true });

let trashed = null;
const sync = new GoogleCalendarSync({
  device: deviceId(),
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
    read: () => {
      const text = fs.readText(STATE_FILE);
      return text ? JSON.parse(text) : null;
    },
    write: (state) => {
      fs.mkdirs('_memoking');
      fs.writeText(STATE_FILE, JSON.stringify(state, null, 1));
    },
  },
  memos: {
    all: () => app.vault?.allReminders() ?? [],
    state: (id) => {
      if (app.vault?.get(id)) return 'present';
      trashed ??= app.vault?.trashedIds() ?? new Set();
      return trashed.has(id) ? 'trashed' : 'missing';
    },
    setReminder: (id, reminderId, reminder) => {
      const memo = app.vault?.get(id);
      if (!memo) return;
      const list = memo.reminders ?? [];
      const next = reminder
        ? (list.some((r) => r.id === reminderId) ? list.map((r) => (r.id === reminderId ? reminder : r)) : [...list, reminder])
        : list.filter((r) => r.id !== reminderId);
      app.setReminders(id, next);
      changed();
    },
    create: (title, reminder) => {
      if (!app.vault) return null;
      const id = app.vault.import({ body: `# ${title}\n` });
      if (id) {
        app.setReminders(id, [normalizeReminder(reminder)].filter(Boolean));
        changed();
      }
      return id;
    },
  },
});

let onChanged = () => {};
const changed = () => onChanged();

export async function runCalendarSync({ force = false } = {}) {
  if (!connected() || !app.vault) return info();
  status = { ...status, running: true };
  emit();
  trashed = null;
  try {
    const res = await sync.run({ force });
    status = { ...status, running: false, error: '', lastSync: res.lastSync ?? status.lastSync, holder: res.skipped ? res.holder : '', calendarId: res.calendarId ?? status.calendarId, last: res };
  } catch (err) {
    console.warn('[gcal]', err);
    status = { ...status, running: false, error: err.message || 'Google 캘린더와 맞추지 못했어요' };
  }
  emit();
  return info();
}

let soonTimer = 0;
let lastSig = null;
/** 일정(이름 · 때 · 반복)이 바뀌었을 때만 몇 초 뒤에 */
export function calendarSyncSoon() {
  if (!connected() || !app.vault) return;
  const sig = app.vault.allReminders().map((i) => `${keyOf(i.memoId, i.reminder.id)}=${shapeHash(shapeOfReminder(i.reminder, i.title))}`).sort().join('\n');
  if (sig === lastSig) return;
  lastSig = sig;
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => runCalendarSync(), AFTER_CHANGE_MS);
}

/** 일정 탭(list-reminders.js · calendar-links.js)이 쓰는 모양 — PC 의 api.calendars.google 과 같다 */
export const googleCalendar = {
  status: async () => info(),
  connect: async () => {
    const ok = await call('googleCalendarAuth');
    if (!ok) throw new Error('캘린더 권한을 허용하지 않았어요');
    ls.set(ON_KEY, '1');
    return runCalendarSync({ force: true });
  },
  cancel: async () => {},
  disconnect: async () => {
    ls.set(ON_KEY, null);
    status = { ...status, error: '', holder: '', last: null };
    emit();
    return info();
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
