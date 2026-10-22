// 예약 알림 실행기 — desktop/alarms.js 와 같은 규칙에 휴대폰 사정을 더했다.
//   앱이 켜져 있을 때: 15초마다 살펴 울릴 때가 된 알림을 울리고 메모 파일에 last 를 적는다.
//   앱이 꺼져 있을 때: 다음 알림 시각들을 시스템 알람에 맡겨 둔다 (Alarms.kt). 그때 울린 알림은
//                     다음에 앱을 켰을 때 다시 울리지 않고 last 만 적는다 (wasFired).
import { dueOccurrence, dueAtStartup, markFired, upcomingAlerts, alarmLabel, alarmText, alarmTitle } from '../../app/js/core/reminders.js';
import { extractPreview } from '../../app/js/core/memo-file.js';
import { native } from './native.js';
import { quietAlarm } from '../../app/js/core/work-hours.js';
import { UI } from '../../app/js/core/ui-text.js';

// 일정의 미리 알림마다 따로 (같은 일정의 "하루 전" 과 "30분 전" 이 서로를 지우지 않게)
const keyOf = (memoId, reminder, offset = 0) => `${memoId}/${reminder.id}${offset ? `/${offset}` : ''}`;
const AHEAD = 14; // 앞으로 몇 회차의 알림을 시스템에 맡길지 (매일 일정이면 알림이 몇 개든 2주치)

export { alarmLabel };

/**
 * @param {{ getVault: () => import('./vault.js').Vault | null,
 *           onFire: (memoId: string, reminder: object, alarm: { label: string, missed: boolean }) => void,
 *           getHours?: () => object, interval?: number }} options
 *   getHours: 업무 시간 (퇴근 뒤 Work 알림은 조용히 — core/work-hours.js)
 */
export function createAlarms({ getVault, onFire, getHours = () => null, interval = 15_000 }) {
  let timer = null;
  let scheduleTimer = null;

  function fire(memoId, reminder, info, { silent = false } = {}) {
    const vault = getVault();
    const memo = vault?.get(memoId);
    if (!memo) return;
    const { title, label, full } = alarmText(reminder, memo.title, info);
    const alarm = { reminderId: reminder.id, label: full, missed: Boolean(info.missed) };
    if (quietAlarm(memo, new Date(), getHours())) return; // 퇴근 뒤 · 쉬는 날의 Work 알림: 울림 표시만 (띄우지도 열지도 않는다)
    if (!silent) {
      try {
        native.notify({
          key: keyOf(memoId, reminder, info.offset),
          title,
          text: [label, memo.locked ? '' : extractPreview(memo.body, 120)].filter(Boolean).join('\n'), // 잠긴 메모는 연 동안에도 내용을 알림에 보이지 않는다
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
      let marked = null;
      try {
        marked = vault.updateReminder(memoId, markFired(reminder, t));
      } catch (err) {
        console.error(UI.ringMarkFail, err); // 이 메모만 건너뛰고 다른 알림은 계속
      }
      if (!marked) continue; // 적지 못했으면 다시 읽은 뒤 다음 차례에
      // 시스템 알람이 이미 울렸으면 알림 막대에 다시 띄우지 않는다
      const already = info.at && native.wasFired(keyOf(memoId, reminder, info.offset), info.at);
      try {
        fire(memoId, reminder, info, { silent: already });
      } catch (err) {
        console.error(UI.ringFail, err);
      }
      count++;
    }
    if (count) schedule();
    return count;
  }

  const tick = () => run((r, t) => {
    const due = dueOccurrence(r, t);
    return due ? { missed: due.missed, at: due.at.getTime(), start: due.start, offset: due.offset, also: due.also } : null;
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
    for (const { memoId, title: memoTitle, reminder: r } of vault.allReminders()) {
      if (!r.enabled || r.kind === 'startup') continue;
      if (r.kind === 'timer' && r.last) continue;
      const memo = vault.get(memoId);
      const preview = memo?.locked ? '' : extractPreview(memo?.body ?? '', 120); // 잠긴 메모의 풀린 글이 예약 알림에 실리지 않게
      const title = alarmTitle(r, memoTitle);
      // 앞으로 울릴 알림(미리 알림 포함)을 몇 번 함께 맡겨, 앱을 한동안 열지 않아도 계속 울리게 한다
      const lastFired = r.last ? new Date(r.last) : null;
      const from = lastFired && lastFired > now ? lastFired : now;
      for (const next of upcomingAlerts(r, from, r.kind === 'repeat' ? AHEAD : 1)) {
        if (quietAlarm(memo, next.at, getHours())) continue; // 업무 시간 밖에 울릴 Work 알림은 시스템에 맡기지 않는다
        const { label, full } = alarmText(r, memoTitle, { start: next.start, offset: next.offset, also: next.also }, next.at);
        items.push({
          key: keyOf(memoId, r, next.offset), at: next.at.getTime(), title,
          text: [label, preview].filter(Boolean).join('\n'), memoId, label: full, action: r.action,
        });
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
