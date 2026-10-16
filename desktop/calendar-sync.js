// Google 캘린더 상호 동기화 — PC 메인 프로세스 쪽 (엔진 · 돌리는 규칙은 휴대폰과 같은 app/js/core/gcal-sync.js · gcal-runner.js)
//   로그인: Drive 연결과 따로 (권한: 메모킹이 만든 캘린더만 — calendar.app.created). 같은 OAuth 클라이언트를 쓴다
//   언제: 켤 때 · 일정이 바뀌고 몇 초 뒤 · 5분마다 · "지금 맞추기"
//   상태 파일 _memoking/google-calendar.json 은 메모 폴더에 있어 Drive 로 휴대폰과 함께 쓴다 (한 기기만 맡는 임대 포함)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleAuth } from './drive/google-auth.js';
import { GoogleCalendarSync, CAL_SCOPE, STATE_FILE } from '../app/js/core/gcal-sync.js';
import { vaultMemos, createCalendarRunner } from '../app/js/core/gcal-runner.js';

const EVERY_MS = 5 * 60_000;

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
  let timer = null;

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

  const memos = vaultMemos({ getVault, saveReminders: (id, list) => getVault()?.setReminders(id, list), onChanged });
  const localFile = path.join(userData, 'google-calendar-local.json');
  const sync = new GoogleCalendarSync({
    request,
    device: `pc:${os.hostname()}`,
    memos,
    // 이 PC 에만: 이 PC 가 만든 캘린더 (휴대폰과 동시에 만들었으면 진 쪽을 지운다)
    local: {
      get: () => {
        try {
          return JSON.parse(fs.readFileSync(localFile, 'utf8'));
        } catch {
          return null;
        }
      },
      set: (v) => (v ? fs.writeFileSync(localFile, JSON.stringify(v)) : fs.rmSync(localFile, { force: true })),
    },
    store: {
      // 없으면 null(처음), 읽지 못하면 오류 (엔진이 이번엔 건너뛴다)
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
  });
  const runner = createCalendarRunner({ sync, memos, connected: () => auth.connected, getVault, onStatus });

  return {
    info: runner.info,
    run: runner.run,
    soon: runner.soon,
    start() {
      clearInterval(timer);
      timer = setInterval(() => runner.run(), EVERY_MS);
      timer.unref?.();
      setTimeout(() => runner.run(), 5_000).unref?.();
    },
    async connect() {
      await auth.login();
      return runner.run({ force: true });
    },
    cancelConnect: () => auth.cancelLogin(),
    disconnect() {
      auth.signOut();
      return runner.forget();
    },
  };
}
