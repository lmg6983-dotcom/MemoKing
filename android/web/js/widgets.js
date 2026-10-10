// 홈 화면 위젯 (Widgets.kt) — 위젯에 놓인 메모들의 보일 내용을 앱에 보내고, 메모 메뉴의 "홈 화면에 놓기"
//   보일 줄 만들기는 공용 core/widget-lines.js (체크 줄 번호 규칙이 Widgets.kt 와 같아야 함)
import { widgetMemo } from '../../app/js/core/widget-lines.js';
import { widget as native } from './native.js';
import { app } from './state.js';

let timer = null;
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
    return memo?.file ? widgetMemo(memo) : { id, gone: true };
  });
  try {
    native.publish(JSON.stringify(memos));
  } catch (err) {
    console.warn('[위젯]', err);
  }
}

/** 메모 메뉴 › 홈 화면에 놓기 */
export function pin(id, { toast }) {
  publish(id); // 놓이자마자 내용이 보이게 먼저
  let ok = false;
  try {
    ok = native.pin(id);
  } catch {
    ok = false;
  }
  if (!ok) toast('이 홈 화면에서는 바로 놓을 수 없어요. 홈 화면을 길게 눌러 위젯 › 메모킹을 놓은 뒤 눌러 메모를 골라 주세요', true);
}

/** 위젯 고르기 목록에서 놓은 위젯을 눌렀을 때: 다음에 누르는 메모를 그 위젯에 */
export function startPick(widgetId, { toast }) {
  pickFor = widgetId;
  toast('위젯에 보일 메모를 눌러 골라 주세요');
}

/** 메모를 열려고 할 때: 고르는 중이면 위젯에 놓고 true (열지 않음) */
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
