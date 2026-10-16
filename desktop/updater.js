import { decodeEntities } from '../app/js/core/entities.js';

// 자동 업데이트 — electron-updater 로 공개 배포 저장소(lmg6983-dotcom/memoking-releases)의 Release 를 본다
//   앱에는 토큰이 없다: 공개 저장소라 읽기에 토큰이 필요 없고, 저장소 주소는 빌드가 넣은 app-update.yml 에서 읽는다.
//   흐름: 켤 때(8초 뒤) · 4시간마다 · 절전에서 깨거나 잠금을 풀 때(1시간 넘게 안 봤으면) · 설정의 "업데이트 확인" → 새 버전이 있으면 화면(목록 창)에 알림(버전 · 바뀐 점)
//         → 사용자가 받기를 고르면 받는 중 진행률 → 다 받으면 "지금 재시작" / "나중에 (끝낼 때 설치)"
//   "나중에" 를 고른 그 버전은 24시간 동안 다시 묻지 않는다. 개발 중(app.isPackaged 가 아님)에는 확인하지 않는다.
//   오류(네트워크 · 서명 · 파일)는 알리기만 하고 지금 버전은 그대로 쓴다.
export const CHECK_EVERY_MS = 4 * 60 * 60_000;
export const STALE_MS = 60 * 60_000; // 깨어날 때 이보다 오래 안 봤으면 다시 본다
export const REMIND_MS = CHECK_EVERY_MS - 10 * 60_000; // 같은 버전을 저절로 다시 알리는 간격 (창을 그냥 닫아도 잠금 풀 때마다 뜨지 않게)
export const SNOOZE_MS = 24 * 60 * 60_000;
const FIRST_CHECK_MS = 8_000; // 켜고 곧 (창들이 다 뜬 뒤)

/** 오류 → 사용자에게 보일 말 (네트워크 · 서명 · 그 밖) */
export function updateErrorText(err) {
  const msg = String(err?.message ?? err ?? '');
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|net::ERR_|network|socket/i.test(msg)) return '인터넷에 연결되지 않아 업데이트를 확인하지 못했어요. 지금 버전은 그대로 쓸 수 있어요';
  if (/sign|certificate|publisherName|not signed/i.test(msg)) return '새 설치 파일의 서명을 확인하지 못해 설치하지 않았어요. 지금 버전은 그대로 쓸 수 있어요';
  if (/404|latest\.yml|Cannot find/i.test(msg)) return '업데이트 정보를 찾지 못했어요. 잠시 뒤 다시 확인해 주세요';
  return '업데이트 중 문제가 생겼어요. 지금 버전은 그대로 쓸 수 있어요';
}

/** 이 버전 알림을 지금 숨길까 ("나중에" 를 고른 지 24시간 안) */
export function isSnoozed(snooze, version, now = Date.now()) {
  return Boolean(snooze && snooze.version === version && now < snooze.until);
}

/** 릴리스 노트(문자열 또는 [{ version, note }]) → 글 */
export function notesText(notes) {
  if (!notes) return '';
  const raw = Array.isArray(notes) ? notes.map((n) => n?.note ?? '').join('\n') : String(notes);
  // GitHub 이 HTML 로 줄 때가 있다 — 태그는 벗기고 &amp; 같은 글자는 되돌린다
  return decodeEntities(raw.replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]*\n[\s]*\n/g, '\n').trim().slice(0, 4000);
}

export class Updater {
  /**
   * @param {{ send: (channel: string, payload: any) => void, settings: object, saveSettings: () => void,
   *           beforeInstall: () => Promise<void> | void, notify?: (t: object) => void, loadUpdater?: () => Promise<any>, packaged: boolean }} o
   *   packaged: app.isPackaged (electron 을 여기서 부르지 않아 단위 테스트가 된다)
   *   send: 화면(목록 창)에 알림 · beforeInstall: 재시작 전에 쓰던 메모 저장 · notify: 목록 창이 없을 때 Windows 알림
   */
  constructor({ send, settings, saveSettings, beforeInstall, notify = () => {}, loadUpdater, packaged = false }) {
    Object.assign(this, { send, settings, saveSettings, beforeInstall, notify, packaged });
    this.loadUpdater = loadUpdater ?? (async () => (await import('electron-updater')).default.autoUpdater);
    this.state = { status: 'idle' }; // idle | checking | available | downloading | ready | latest | error
    this.updater = null;
    this.timer = null;
    this.lastCheckAt = 0;
  }

  get enabled() {
    return this.packaged; // 개발 중에는 app-update.yml 이 없어 확인할 수 없다
  }

  /** 한 번만 (확인 단추가 준비 중에 눌려도 이벤트를 두 번 달지 않게) */
  start() {
    if (!this.enabled) return Promise.resolve();
    this.starting ??= this.init().catch((err) => {
      console.warn('[update] electron-updater 를 불러오지 못했어요', err);
      this.starting = null; // 다음 확인 때 다시
    });
    return this.starting;
  }

  async init() {
    const u = await this.loadUpdater();
    this.updater = u;
    u.autoDownload = false; // 사용자가 받기를 고른 뒤에
    u.autoInstallOnAppQuit = true; // 받아 둔 업데이트는 앱을 끝낼 때 설치 ("나중에")
    u.on('checking-for-update', () => this.set({ status: 'checking' }));
    u.on('update-not-available', () => this.set({ status: 'latest' }));
    u.on('update-available', (info) => {
      this.set({ status: 'available', version: info.version, notes: notesText(info.releaseNotes), date: info.releaseDate ?? '' });
      if (!this.manual && isSnoozed(this.settings.updateSnooze, info.version)) return; // "나중에" 고른 버전 — 24시간 조용히
      const last = this.announced;
      if (!this.manual && last?.version === info.version && Date.now() - last.at < REMIND_MS) return; // 방금 알린 버전
      this.announced = { version: info.version, at: Date.now() };
      this.announce('update:available');
    });
    u.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent ?? 0), transferred: p.transferred ?? 0, total: p.total ?? 0, bytesPerSecond: p.bytesPerSecond ?? 0 }));
    u.on('update-downloaded', (info) => {
      this.set({ status: 'ready', version: info.version, notes: notesText(info.releaseNotes) || this.state.notes });
      this.announce('update:ready');
    });
    u.on('error', (err) => {
      console.warn('[update]', err);
      this.set({ status: 'error', message: updateErrorText(err) });
    });
    this.firstTimer = setTimeout(() => this.check(), FIRST_CHECK_MS);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
    this.timer = null;
  }

  set(patch) {
    // 상태가 바뀌면 버전 · 바뀐 점만 이어 가고 (진행률 · 오류 글은 버림), 같은 상태면 덧붙인다
    const { version, notes } = this.state;
    this.state = patch.status && patch.status !== this.state.status ? { version, notes, ...patch } : { ...this.state, ...patch };
    this.send('update:state', this.state);
  }

  /** 새 버전 · 받기 끝 — 화면이 있으면 대화 상자, 없으면 Windows 알림 */
  announce(channel) {
    const delivered = this.send(channel, this.state);
    if (!delivered) {
      this.notify({
        title: channel === 'update:ready' ? `메모킹 v${this.state.version} 을 설치할 준비가 됐어요` : `메모킹 새 버전 v${this.state.version}`,
        body: channel === 'update:ready' ? '메모킹을 다시 시작하면 바로 바뀌어요' : '눌러서 바뀐 점을 보고 받을 수 있어요',
        channel,
      });
    }
  }

  /** manual: 설정의 "업데이트 확인" (숨겨 둔 버전도 다시 보여 준다) → 지금 상태 */
  async check({ manual = false } = {}) {
    if (!this.enabled) return { status: 'dev', message: '개발 중에는 업데이트를 확인하지 않아요' };
    if (!this.updater) await this.start();
    if (!this.updater) return { status: 'error', message: '업데이트 기능을 준비하지 못했어요' };
    if (['downloading', 'ready'].includes(this.state.status)) return this.state; // 이미 받는 중 · 받아 둠
    this.manual = manual;
    this.lastCheckAt = Date.now();
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      this.set({ status: 'error', message: updateErrorText(err) });
    } finally {
      this.manual = false;
    }
    return this.state;
  }

  /** 절전에서 깨어남 · 잠금 풀림: 한동안 안 봤으면 다시 본다 (오래 켜 둔 PC 도 새 버전을 놓치지 않게) */
  checkIfStale(now = Date.now()) {
    if (!this.updater || now - this.lastCheckAt < STALE_MS) return null;
    return this.check();
  }

  async download() {
    if (!this.updater || this.state.status !== 'available') return this.state;
    this.set({ status: 'downloading', percent: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (err) {
      this.set({ status: 'error', message: updateErrorText(err) });
    }
    return this.state;
  }

  /** "나중에": 받기 전이면 그 버전을 24시간 숨기고, 받아 둔 뒤면 끝낼 때 설치 (autoInstallOnAppQuit) */
  later() {
    if (['available', 'ready'].includes(this.state.status) && this.state.version) { // 지금 제안 중인 버전만
      this.settings.updateSnooze = { version: this.state.version, until: Date.now() + SNOOZE_MS };
      this.saveSettings();
    }
    return this.state;
  }

  /** "지금 재시작": 쓰던 메모를 저장하고 설치 → 다시 켬 */
  async installNow() {
    if (!this.updater || this.state.status !== 'ready') return false;
    await this.beforeInstall();
    // isSilent: 설치 화면 없이 · isForceRunAfter: 설치가 끝나면 다시 켬
    this.updater.quitAndInstall(true, true);
    return true;
  }
}
