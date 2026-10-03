// 예약 알림 실행기 — desktop/alarms.js 와 같은 규칙에 휴대폰 사정을 더했다.
//   앱이 켜져 있을 때: 15초마다 살펴 울릴 때가 된 알림을 울리고 메모 파일에 last 를 적는다.
//   앱이 꺼져 있을 때: 다음 알림 시각들을 시스템 알람에 맡겨 둔다 (Alarms.kt). 그때 울린 알림은
//                     다음에 앱을 켰을 때 다시 울리지 않고 last 만 적는다 (wasFired).
import { dueOccurrence, dueAtStartup, markFired, nextOccurrence, describeReminder } from '../../app/js/core/reminders.js';
import { extractPreview } from '../../app/js/core/memo-file.js';
import { native } from './native.js';

const keyOf = (memoId, reminder) => `${memoId}/${reminder.id}`;
const REPEAT_AHEAD = 14; // 매일 알림이면 2주치

export function alarmLabel(reminder, info = {}) {
  const kind = info.missed ? '놓친 알림' : info.startup ? '켤 때 알림' : '알림';
  return `${kind} · ${describeReminder(reminder)}`;
}

/**
 * @param {{ getVault: () => import('./vault.js').Vault | null,
 *           onFire: (memoId: string, reminder: object, alarm: { label: string, missed: boolean }) => void,
 *           interval?: number }} options
 */
export function createAlarms({ getVault, onFire, interval = 15_000 }) {
  let timer = null;
  let scheduleTimer = null;

  function fire(memoId, reminder, info, { silent = false } = {}) {
    const vault = getVault();
    const memo = vault?.get(memoId);
    if (!memo) return;
    const alarm = { reminderId: reminder.id, label: alarmLabel(reminder, info), missed: Boolean(info.missed) };
    if (!silent) {
      try {
        native.notify({
          key: keyOf(memoId, reminder),
          title: memo.title,
          text: [alarm.label, extractPreview(memo.body, 120)].filter(Boolean).join('\n'),
          memoId,
          label: alarm.label,
        });
      } catch (err) {
        console.warn('알림을 띄우지 못했어요', err);
      }
    }
    onFire(memoId, reminder, alarm);
  }

  function run(pick) {
    const vault = getVault();
    if (!vault) return 0;
    const t = new Date();
    let count = 0;
    for (const { memoId, reminder } of vault.allReminders()) {
      const info = pick(reminder, t);
      if (!info) continue;
      // 울리기 "전에" 먼저 울림 표시(last)를 파일에 적어, 같은 알림이 두 번 울리지 않게 한다.
      vault.updateReminder(memoId, markFired(reminder, t));
      // 시스템 알람이 이미 울렸으면 알림 막대에 다시 띄우지 않는다
      const already = info.at && native.wasFired(keyOf(memoId, reminder), info.at);
      try {
        fire(memoId, reminder, info, { silent: already });
      } catch (err) {
        console.error('알림을 울리지 못했습니다', err);
      }
      count++;
    }
    if (count) schedule();
    return count;
  }

  const tick = () => run((r, t) => {
    const due = dueOccurrence(r, t);
    return due ? { missed: due.missed, at: due.at.getTime() } : null;
  });

  // 앱을 켤 때 (실행할 때 알림) — 처음 켤 때 한 번만
  const startup = () => run((r, t) => (dueAtStartup(r, t) ? { startup: true } : null));

  // 앞으로 울릴 알림을 시스템에 맡긴다
  function schedule() {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
    const vault = getVault();
    if (!vault) return;
    const now = new Date();
    const items = [];
    for (const { memoId, title, reminder: r } of vault.allReminders()) {
      if (!r.enabled || r.kind === 'startup') continue;
      if ((r.kind === 'timer' || r.kind === 'at') && r.last) continue;
      const label = alarmLabel(r);
      const memo = vault.get(memoId);
      const text = [label, extractPreview(memo?.body ?? '', 120)].filter(Boolean).join('\n');
      // 반복 알림은 앞으로 몇 회차를 함께 맡겨, 앱을 한동안 열지 않아도 계속 울리게 한다
      let from = now;
      for (let i = 0; i < (r.kind === 'repeat' ? REPEAT_AHEAD : 1); i++) {
        const next = nextOccurrence(r, from);
        if (!next) break;
        items.push({ key: keyOf(memoId, r), at: next.getTime(), title, text, memoId, label, action: r.action });
        from = next;
      }
    }
    try {
      native.scheduleAlarms(items);
    } catch (err) {
      console.warn('알림 예약을 맡기지 못했어요', err);
    }
  }

  return {
    tick,
    startup,
    schedule,
    // 메모가 자주 바뀌므로 잠시 모았다가
    scheduleSoon() {
      clearTimeout(scheduleTimer);
      scheduleTimer = setTimeout(schedule, 1500);
    },
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, interval);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
