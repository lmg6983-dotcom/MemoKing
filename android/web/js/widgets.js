// 홈 화면 위젯 (Widgets.kt) — 위젯에 놓인 메모들의 보일 내용을 앱에 보내고, 메모 메뉴의 "홈 화면에 놓기"
//   보일 줄 만들기는 공용 core/widget-lines.js (체크 줄 번호 규칙이 Widgets.kt 와 같아야 함)
import { widgetMemo } from '../../app/js/core/widget-lines.js';
import { widget as native } from './native.js';
import { app } from './state.js';

let timer = null;
let goneTimer = null;
const GONE_RECHECK = 65_000; // Widgets.kt 의 GONE_CONFIRM_MS 보다 조금 길게
let pickFor = null; // 위젯 고르기 목록에서 놓은 위젯: 다음에 누르는 메모를 그 위젯에

/** 메모 폴더가 바뀌면 잠시 뒤 위젯 내용을 다시 보낸다 (위젯이 없으면 아무 일 없음) */
export function publishSoon(delay = 400) {
  clearTimeout(timer);
  timer = setTimeout(publish, delay);
}

export function publish(only = null) {
  if (!app.vault) return;
  let ids;
  try {
    ids = only ? [only] : native.memoIds() ?? [];
  } catch {
    return; // 위젯을 모르는 예전 앱
  }
  if (!ids.length) return;
  const memos = ids.map((id) => {
    const memo = app.vault.get(id);
    if (!memo?.file) return { id, gone: true };
    // 잠긴 메모는 위젯에 내용을 보이지 않는다 (열어 둔 동안에도)
    if (memo.locked) return { id, title: memo.title, color: memo.color ?? 'yellow', file: memo.file, locked: true, lines: [{ t: '🔒 잠긴 메모예요', kind: 'text' }] };
    return widgetMemo(memo);
  });
  try {
    native.publish(JSON.stringify(memos));
  } catch (err) {
    console.warn('[위젯]', err);
  }
  // 없어진 메모: 위젯은 한동안 계속 없을 때만 놓아 준다 (Widgets.kt) — 그때 한 번 더 보내 확인하게
  if (memos.some((m) => m.gone)) {
    clearTimeout(goneTimer);
    goneTimer = setTimeout(() => publish(), GONE_RECHECK);
  }
}

/** 메모 메뉴 › 홈 화면에 놓기 */
export function pin(id, { toast }) {
  publish(id); // 놓이자마자 내용이 보이게 먼저
  let ok = false;
  let reason = '';
  try {
    ok = native.pin(id);
  } catch (err) {
    reason = err?.message ?? '';
  }
  // 앱 쪽 오류면 그 이유도 (런처가 바로 놓기를 지원하지 않는 것과 구분해 알 수 있게)
  if (!ok) toast(`${reason ? '홈 화면에 바로 놓지 못했어요' : '이 홈 화면에서는 바로 놓을 수 없어요'}. 홈 화면을 길게 눌러 위젯 › 메모킹을 놓은 뒤 눌러 메모를 골라 주세요${reason ? ` (${reason})` : ''}`, true);
}

/** 위젯 고르기 목록에서 놓은 위젯을 눌렀을 때: 다음에 누르는 메모를 그 위젯에 */
export function startPick(widgetId, { toast }) {
  if (!Number.isInteger(widgetId) || widgetId < 0) return; // 위젯 번호가 없는 요청은 무시
  pickFor = widgetId;
  toast('위젯에 보일 메모를 눌러 골라 주세요');
}

/**
 * 고르기를 그만둔다 — 앱을 떠나거나(홈·뒤로), 목록 카드가 아닌 길(+ 새 메모 · 알림 · 다른 메모 연결)로 메모를 열 때.
 * 그래야 나중에 연 메모가 엉뚱하게 위젯에 놓이지 않는다.
 */
export function cancelPick() {
  pickFor = null;
}

/** 목록에서 메모 카드를 눌렀을 때: 고르는 중이면 위젯에 놓고 true (열지 않음) */
export function takePick(id, { toast }) {
  if (pickFor == null) return false;
  const widgetId = pickFor;
  pickFor = null;
  publish(id);
  try {
    native.assign(widgetId, id);
    toast('홈 화면 위젯에 놓았어요');
  } catch (err) {
    toast(err.message, true);
  }
  return true;
}
