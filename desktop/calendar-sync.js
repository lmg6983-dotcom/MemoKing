// Google 캘린더 상호 동기화 — PC 메인 프로세스 쪽 (엔진은 휴대폰과 같은 app/js/core/gcal-sync.js)
//   로그인: Drive 연결과 따로 (권한: 메모킹이 만든 캘린더만 — calendar.app.created). 같은 OAuth 클라이언트를 쓴다
//   언제: 켤 때 · 메모가 바뀌고 몇 초 뒤 · 5분마다 · "지금 맞추기"
//   상태 파일 _memoking/google-calendar.json 은 메모 폴더에 있어 Drive 로 휴대폰과 함께 쓴다 (한 기기만 맡는 임대 포함)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleAuth } from './drive/google-auth.js';
import { GoogleCalendarSync, CAL_SCOPE, STATE_FILE, shapeOfReminder, shapeHash, keyOf } from '../app/js/core/gcal-sync.js';
import { normalizeReminder } from '../app/js/core/reminders.js';

const EVERY_MS = 5 * 60_000;
const AFTER_CHANGE_MS = 8_000;

/**
 * @param {{ userData: string, bundledClient: string[], driveAuth: () => any, fetch: typeof fetch, openExternal: (url: string) => void,
 *           safeStorage?: any, getVault: () => any, onChanged: (memoIds: string[]) => void, onStatus: (info: any) => void }} o
 */
export function createCalendarSync({ userData, bundledClient, driveAuth, fetch: fetchImpl, openExternal, safeStorage, getVault, onChanged, onStatus }) {
  const auth = new GoogleAuth({
    file: path.join(userData, 'google-calendar-auth.json'),
    bundledClient,
    fetch: fetchImpl,
    openExternal,
    safeStorage,
    scope: CAL_SCOPE,
    fallbackClient: () => driveAuth()?.refreshClient?.() ?? driveAuth()?.client?.() ?? null,
  });
  let status = { lastSync: 0, error: '', running: false, holder: '', calendarId: '', last: null };
  let timer = null;
  let soonTimer = null;
  let lastSig = null;

  async function request(method, url, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await auth.token();
      const res = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 401 && attempt === 0) {
        auth.invalidate();
        continue;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    }
    return { status: 401, json: null };
  }

  const stateFile = () => {
    const root = getVault()?.root;
    return root ? path.join(root, ...STATE_FILE.split('/')) : null;
  };

  let trashed = null; // 한 번 맞추는 동안만
  const sync = new GoogleCalendarSync({
    request,
    device: `pc:${os.hostname()}`,
    store: {
      read: () => {
        const f = stateFile();
        return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
      },
      write: (state) => {
        const f = stateFile();
        if (!f) return;
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const tmp = `${f}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
        fs.renameSync(tmp, f);
      },
    },
    memos: {
      all: () => getVault()?.allReminders() ?? [],
      state: (id) => {
        const vault = getVault();
        if (vault?.get(id)) return 'present';
        trashed ??= vault?.trashedIds() ?? new Set();
        return trashed.has(id) ? 'trashed' : 'missing';
      },
      setReminder: (id, reminderId, reminder) => {
        const vault = getVault();
        const memo = vault?.get(id);
        if (!memo) return;
        const list = memo.reminders ?? [];
        const next = reminder
          ? (list.some((r) => r.id === reminderId) ? list.map((r) => (r.id === reminderId ? reminder : r)) : [...list, reminder])
          : list.filter((r) => r.id !== reminderId);
        if (!vault.setReminders(id, next.map((r) => normalizeReminder(r)).filter(Boolean))) throw new Error('메모에 일정을 저장하지 못했어요 (다른 기기에서 바뀌는 중)');
        onChanged([id]);
      },
      create: (title, reminder) => {
        const vault = getVault();
        if (!vault) return null;
        const id = vault.import({ body: `# ${title}\n` });
        if (id) {
          vault.setReminders(id, [normalizeReminder(reminder)].filter(Boolean));
          onChanged([id]);
        }
        return id;
      },
    },
  });

  const info = () => ({ ...status, connected: auth.connected, configured: auth.configured });
  const emit = () => onStatus(info());

  async function run({ force = false } = {}) {
    if (!auth.connected || !getVault()) return info();
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

  function start() {
    clearInterval(timer);
    timer = setInterval(() => run(), EVERY_MS);
    timer.unref?.();
    setTimeout(() => run(), 5_000).unref?.();
  }

  return {
    info,
    run,
    start,
    /** 메모가 바뀐 뒤 조금 있다가 (여러 번 바뀌어도 한 번) */
    soon() {
      if (!auth.connected) return;
      // 메모 글을 쓸 때마다가 아니라 일정(이름 · 때 · 반복)이 바뀌었을 때만
      const sig = (getVault()?.allReminders() ?? []).map((i) => `${keyOf(i.memoId, i.reminder.id)}=${shapeHash(shapeOfReminder(i.reminder, i.title))}`).sort().join('\n');
      if (sig === lastSig) return;
      lastSig = sig;
      clearTimeout(soonTimer);
      soonTimer = setTimeout(() => run(), AFTER_CHANGE_MS);
      soonTimer.unref?.();
    },
    async connect() {
      await auth.login();
      return run({ force: true });
    },
    cancelConnect: () => auth.cancelLogin(),
    disconnect() {
      auth.signOut();
      status = { ...status, error: '', holder: '', last: null };
      emit();
      return info();
    },
  };
}
