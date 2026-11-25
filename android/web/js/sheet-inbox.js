// AI 받은함 시트 처리 (휴대폰) — 동기화를 마친 뒤 받은 메모 담당 기기일 때 app.js 가 부른다. PC 는 desktop-rs/app/src/drive.rs sheet_inbox
//   ① 시트가 그대로면 끝 ② CSV 로 받아 pending 줄을 메모 폴더에 적용 ③ 그사이 시트가 그대로일 때만 결과를 적어 덮어쓴다 (아니면 다음 차례에)
//   적용했지만 결과를 적지 못한 요청은 req_id 로 기억해 두었다가 다음 차례에 다시 적용하지 않고 그 결과만 적는다
import { call } from './native.js';
import { runSheet } from '../../app/js/core/sheet-inbox.js';

const APPLIED_KEY = 'memoking.sheetApplied';
let sheet = { id: '', stamp: '' }; // 시트 id · 지난번 본 값
let busy = false;

function loadApplied() {
  try {
    return new Map(JSON.parse(localStorage.getItem(APPLIED_KEY) ?? '[]'));
  } catch {
    return new Map();
  }
}

function saveApplied(applied) {
  try {
    localStorage.setItem(APPLIED_KEY, JSON.stringify([...applied].slice(-200)));
  } catch {
    // 이번 실행 동안만 기억
  }
}

/** 한 차례 처리 → 메모에 반영한 요청 수 */
export async function processSheet(vault) {
  if (busy) return 0;
  busy = true;
  try {
    const got = await call('sheetInbox', { op: 'fetch', id: sheet.id, since: sheet.stamp });
    if (!got?.id) return 0; // 아직 한 번도 맞추지 않았다
    if (got.csv == null) {
      sheet = { id: got.id, stamp: got.stamp };
      return 0;
    }
    const applied = loadApplied();
    const before = applied.size;
    const out = runSheet(got.csv, (job, reqId) => {
      if (applied.has(reqId)) return applied.get(reqId);
      const r = vault.applySheetJob(job);
      applied.set(reqId, r);
      return r;
    });
    if (applied.size !== before) saveApplied(applied);
    if (!out) {
      sheet = { id: got.id, stamp: got.stamp };
      return 0;
    }
    await call('sheetInbox', { op: 'update', id: got.id, stamp: got.stamp, csv: out.csv });
    sheet = { id: got.id, stamp: '' }; // 덮어쓴 바로 뒤에 AI 가 더한 줄도 놓치지 않게 다음 차례에 한 번 더 읽는다
    return out.done;
  } finally {
    busy = false;
  }
}
