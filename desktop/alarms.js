// 예약 알림 실행기 — 15초마다 모든 메모의 알림을 살펴 울릴 때가 된 것을 울린다.
// 울리기 "전에" 먼저 울림 표시(last)를 파일에 적어, 같은 알림이 두 번 울리지 않게 한다.
import { dueOccurrence, dueAtStartup, markFired } from '../app/js/core/reminders.js';

/**
 * @param {{ getVault: () => import('./vault.js').Vault | null,
 *           fire: (memoId: string, reminder: object, info: { missed?: boolean, startup?: boolean }) => void,
 *           now?: () => Date, interval?: number }} options
 */
export function createAlarmRunner({ getVault, fire, now = () => new Date(), interval = 15_000 }) {
  let timer = null;

  function run(pick) {
    const vault = getVault();
    if (!vault) return 0;
    const t = now();
    let count = 0;
    for (const { memoId, reminder } of vault.allReminders()) {
      const info = pick(reminder, t);
      if (!info) continue;
      // 울림 표시를 적지 못했으면(그사이 파일이 바뀜) 이번엔 울리지 않는다 — 다시 읽은 뒤 다음 차례에 (두 번 울리지 않게)
      let marked = null;
      try {
        marked = vault.updateReminder(memoId, markFired(reminder, t));
      } catch (err) {
        console.error('울림 표시를 적지 못했습니다', err); // 이 메모만 건너뛰고 다른 알림은 계속
      }
      if (!marked) continue;
      try {
        fire(memoId, reminder, info);
      } catch (err) {
        console.error('알림을 울리지 못했습니다', err);
      }
      count++;
    }
    return count;
  }

  // 날짜·시간·반복·타이머
  const tick = () => run((r, t) => {
    const due = dueOccurrence(r, t);
    return due ? { missed: due.missed, start: due.start, offset: due.offset, also: due.also } : null;
  });

  // 앱을 시작할 때 (실행할 때 알림) — 프로그램이 켜질 때 한 번만 부른다
  const startup = () => run((r, t) => (dueAtStartup(r, t) ? { startup: true } : null));

  return {
    tick,
    startup,
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
