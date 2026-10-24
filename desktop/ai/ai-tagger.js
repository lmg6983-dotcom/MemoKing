// AI 뒤처리 (PC 메인) — 닫은 메모 · 매직키로 저장한 메모 · 설정의 "모든 메모" 를
//   하나씩 차례로 (모델이 하나라서). 열려 있는 메모는 닫을 때, 그사이 고친 메모는 건드리지 않는다.
//   ① 일정: 새로 쓴 줄의 앞으로의 날짜를 AI 가 골라 일정으로 (core/ai-events.js, 본 줄은 머리말 aiEvents — 지운 일정은 되살리지 않음)
//   ② 태그: 메모마다 한 번, AI 가 고른 태그를 사용자 태그와 합쳐 3개까지 (본 메모는 머리말 aiTags — 지운 AI 태그는 지워진 채)
import { extractTags } from '../../app/js/core/tags.js';
import { appendTags, removeTags } from '../../app/js/core/tag-suggest.js';
import { isBlankBody } from '../../app/js/core/memo-file.js';
import { MAX_TAGS } from '../../app/js/core/ai-tasks.js';

// 이보다 오래된 메모를 처음 볼 때는 일정을 넣지 않고 본 줄로만 ("내일" 이 쓴 날이 아니라 오늘 기준으로 계산되므로)
const FRESH_MS = 24 * 60 * 60_000;

/**
 * @param {{ getVault: () => any, tasks: () => { autoTags: Function, autoEvents: Function }, ready: () => Promise<boolean>,
 *   isOpen: (id: string) => boolean, enabled: () => boolean, eventsOn?: () => boolean,
 *   onEvents?: (id: string, events: object[]) => void, onProgress?: (p: object | null) => void }} o  enabled: 태그
 *   다른 기기(휴대폰)에서 들어온 메모는 여기서 하지 않는다 — PC 가 여러 대면 저마다 고쳐 써서 Drive 충돌 사본이 생기므로, 열었다 닫을 때만
 */
export function createAiTagger({
  getVault, tasks, ready, isOpen, enabled, eventsOn = () => false, onEvents = () => {}, onProgress = () => {},
}) {
  const queue = new Set();
  let running = null;
  let batch = null; // 설정의 "모든 메모": { left: Set, done, total }

  const progress = () => onProgress(batch && { done: batch.done, total: batch.total });

  function add(ids) {
    for (const id of ids) queue.add(id);
    return (running ??= run().finally(() => (running = null)));
  }

  /** 아직 보지 않은 모든 메모 → { done, total } */
  function all() {
    const vault = getVault();
    const todo = (m) => m && m.aiTags == null && !m.locked && !isBlankBody(m.body) && extractTags(m.body).length < MAX_TAGS; // tagOne 이 건너뛰는 메모는 세지 않는다
    const ids = (vault?.list() ?? []).map((m) => m.id).filter((id) => todo(vault.get(id)));
    batch = ids.length ? { left: new Set(ids), done: 0, total: ids.length } : null;
    progress();
    add(ids);
    return { done: 0, total: ids.length };
  }

  function stop() {
    queue.clear();
    batch = null;
    progress();
  }

  async function run() {
    while (queue.size && (enabled() || eventsOn()) && (await ready())) {
      const [id] = queue;
      queue.delete(id);
      try {
        await tagOne(id);
      } catch (err) {
        // 모델이 멈춤 등 — 이 메모는 표시하지 않고(다음에 다시), 한꺼번에 하던 것은 멈춘다
        console.error('AI 태그', err.message);
        if (batch) onProgress({ error: `AI 태그를 달지 못했어요: ${err.message}` });
        queue.clear();
        batch = null;
        return;
      }
      if (batch?.left.delete(id)) {
        batch.done++;
        if (!batch.left.size) batch = null;
        progress();
      }
    }
  }

  async function tagOne(id) {
    const vault = getVault();
    let m = vault?.get(id);
    if (!m || m.locked || isOpen(id) || isBlankBody(m.body)) return;
    const changed = () => getVault() !== vault || vault.get(id)?.body !== m.body || isOpen(id); // 다음에 닫을 때 다시
    if (eventsOn()) {
      const fresh = m.aiEvents != null || Date.now() - Date.parse(m.created ?? '') < FRESH_MS;
      const written = new Date(Date.parse(m.updated ?? '') || Date.now()); // "내일" 은 마지막으로 고친 때 기준
      const r = await tasks().autoEvents(m.body, { seen: m.aiEvents ?? [], existing: m.reminders, fresh, written });
      if (changed()) return;
      if (r.events.length || JSON.stringify(r.seen) !== JSON.stringify(m.aiEvents)) {
        if (vault.addAiEvents(id, r.events, r.seen) && r.events.length) onEvents(id, r.events);
      }
      m = vault.get(id);
    }
    if (!enabled() || m.aiTags || extractTags(m.body).length >= MAX_TAGS) return;
    const names = await tasks().autoTags(m.body, id);
    if (changed()) return;
    vault.setAiTags(id, appendTags(m.body, names), names);
  }

  /** AI 가 단 태그를 모든 메모에서 걷어 낸다 (다시 달지 않음) → 걷어 낸 메모 수. 열려 있는 메모는 건너뜀 */
  function clearAll() {
    stop();
    const vault = getVault();
    let n = 0;
    for (const { id } of vault?.list() ?? []) {
      const m = vault.get(id);
      if (!m?.aiTags?.length || m.locked || isOpen(id)) continue;
      if (vault.setAiTags(id, removeTags(m.body, m.aiTags), [])) n++;
    }
    return n;
  }

  return { add, all, stop, clearAll, status: () => batch && { done: batch.done, total: batch.total } };
}
