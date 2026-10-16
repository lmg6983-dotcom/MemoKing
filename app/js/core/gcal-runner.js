// Google 캘린더 상호 동기화를 돌리는 쪽 (PC 메인 · 휴대폰 같음) — 메모 폴더 잇기, 상태 알리기, 언제 맞출지
//   엔진(gcal-sync.js)은 판단만 하고, 메모를 읽고 쓰는 것과 시각 맞추기는 여기서 (기기마다 다른 것은 넘겨받는다)
import { shapeOfReminder, shapeHash, keyOf } from './gcal-sync.js';
import { normalizeReminder } from './reminders.js';

/**
 * 메모 폴더(Vault — PC · 휴대폰 같은 모양) → 엔진이 쓰는 memos
 * @param {{ getVault: () => any, saveReminders: (memoId: string, list: any[]) => any, onChanged: (ids: string[]) => void }} o
 *   saveReminders: 저장한 목록, 못 하면 null (또는 오류)
 */
export function vaultMemos({ getVault, saveReminders, onChanged }) {
  let trashed = null; // 한 번 맞추는 동안만 (휴지통을 읽는 것은 무겁다)
  const save = (id, list) => {
    const saved = saveReminders(id, list.map((r) => normalizeReminder(r)).filter(Boolean));
    if (!saved) throw new Error('메모에 일정을 저장하지 못했어요 (다른 기기에서 바뀌는 중)');
    return saved;
  };
  return {
    beginRun() {
      trashed = null;
    },
    all: () => getVault()?.allReminders() ?? [],
    // 이 기기의 메모 파일을 마지막으로 쓴(받은) 때 — 다른 기기에서 넣은 일정이 아직 오지 않은 것인지 가린다
    touched: (id) => getVault()?.editedAt?.(id) ?? Infinity,
    state: (id) => {
      const vault = getVault();
      if (vault?.get(id)) return 'present';
      trashed ??= vault?.trashedIds?.() ?? new Set();
      return trashed.has(id) ? 'trashed' : 'missing';
    },
    setReminder: (id, reminderId, reminder) => {
      const memo = getVault()?.get(id);
      if (!memo) return;
      const list = memo.reminders ?? [];
      const next = reminder
        ? (list.some((r) => r.id === reminderId) ? list.map((r) => (r.id === reminderId ? reminder : r)) : [...list, reminder])
        : list.filter((r) => r.id !== reminderId);
      save(id, next);
      onChanged([id]);
    },
    // 캘린더에서 새로 만든 일정 → 새 메모. 일정을 넣지 못하면 빈 메모를 남기지 않는다 (다음에 또 만들지 않게 오류로)
    create: (title, reminder) => {
      const vault = getVault();
      if (!vault) return null;
      const id = vault.import({ body: `# ${title}\n` });
      if (!id) return null;
      try {
        save(id, [reminder]);
      } catch (err) {
        try {
          vault.trash(id);
        } catch {
          // 휴지통에도 못 넣으면 그대로
        }
        throw err;
      }
      onChanged([id]);
      return id;
    },
  };
}

/**
 * 맞추기 · 상태 · "곧 맞추기"
 * @param {{ sync: any, memos: ReturnType<typeof vaultMemos>, connected: () => boolean, getVault: () => any, onStatus: (info: any) => void, afterChangeMs?: number }} o
 */
export function createCalendarRunner({ sync, memos, connected, getVault, onStatus, afterChangeMs = 8_000 }) {
  let status = { lastSync: 0, error: '', running: false, holder: '', calendarId: '', last: null };
  let soonTimer = null;
  const sigs = new Map(); // 메모 id → 일정 모양 (바뀐 메모만 다시 본다)
  const info = () => ({ ...status, connected: connected(), configured: true });
  const emit = () => onStatus(info());

  async function run({ force = false } = {}) {
    if (!connected() || !getVault()) return info();
    status = { ...status, running: true };
    emit();
    memos.beginRun();
    try {
      const res = await sync.run({ force });
      status = {
        ...status, running: false, error: '', lastSync: res.lastSync ?? status.lastSync, holder: res.skipped ? res.holder : '',
        calendarId: res.calendarId ?? status.calendarId, last: res.skipped ? status.last : res,
      };
    } catch (err) {
      console.warn('[gcal]', err);
      status = { ...status, running: false, error: err?.message || 'Google 캘린더와 맞추지 못했어요' };
    }
    emit();
    return info();
  }

  // 한 메모의 일정 모양 (일정이 없으면 '')
  const sigOf = (memo) => (memo?.reminders ?? []).map((r) => `${keyOf(memo.id, r.id)}=${shapeHash(shapeOfReminder(r, memo.title))}`).sort().join('\n');

  /**
   * 일정(이름 · 때 · 반복)이 바뀌었을 때만 몇 초 뒤에 (메모 글을 쓸 때마다가 아니라).
   * ids: 바뀐 메모들 (메모 폴더의 'changed') — 그 메모만 다시 본다. 없으면 모두
   */
  function soon(ids = null) {
    const vault = getVault();
    if (!connected() || !vault) return;
    let changed = false;
    const check = (id) => {
      const sig = sigOf(vault.get(id));
      if ((sigs.get(id) ?? '') !== sig) changed = true;
      if (sig) sigs.set(id, sig);
      else sigs.delete(id);
    };
    if (ids) ids.forEach(check);
    else new Set([...vault.allReminders().map((i) => i.memoId), ...sigs.keys()]).forEach(check);
    if (!changed) return;
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => run(), afterChangeMs);
    soonTimer.unref?.();
  }

  function forget() {
    status = { ...status, error: '', holder: '', last: null };
    emit();
    return info();
  }

  return { info, run, soon, forget };
}
