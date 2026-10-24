// AI 태그 (PC 메인) — 메모마다 한 번, AI 가 고른 태그를 사용자 태그와 합쳐 3개까지 뒤에서 단다.
//   닫은 메모 · 매직키로 저장한 메모 · 다른 기기(휴대폰)에서 들어온 메모 · 설정의 "모든 메모" 를 하나씩 차례로 (모델이 하나라서).
//   본 메모는 머리말 aiTags 로 기억해 다시 달지 않는다 (사용자가 지운 AI 태그는 지워진 채). 열려 있는 메모는 닫을 때.
import { extractTags } from '../../app/js/core/tags.js';
import { appendTags, removeTags } from '../../app/js/core/tag-suggest.js';
import { isBlankBody } from '../../app/js/core/memo-file.js';
import { MAX_TAGS } from '../../app/js/core/ai-tasks.js';

const SETTLE_MS = 60_000; // 다른 기기에서 쓰는 중인 메모는 1분 조용해진 뒤에

/**
 * @param {{ getVault: () => any, tasks: () => { autoTags: Function }, ready: () => Promise<boolean>,
 *   isOpen: (id: string) => boolean, enabled: () => boolean, onProgress?: (p: object | null) => void, settleMs?: number }} o
 */
export function createAiTagger({ getVault, tasks, ready, isOpen, enabled, onProgress = () => {}, settleMs = SETTLE_MS }) {
  const queue = new Set();
  const waiting = new Map(); // id → 타이머 (다른 기기에서 들어온 메모)
  let running = null;
  let batch = null; // 설정의 "모든 메모": { left: Set, done, total }

  const progress = () => onProgress(batch && { done: batch.done, total: batch.total });

  function add(ids) {
    for (const id of ids) queue.add(id);
    return (running ??= run().finally(() => (running = null)));
  }

  function later(ids) {
    for (const id of ids) {
      clearTimeout(waiting.get(id));
      waiting.set(id, setTimeout(() => {
        waiting.delete(id);
        add([id]);
      }, settleMs));
    }
  }

  /** 아직 보지 않은 모든 메모 → { done, total } */
  function all() {
    const vault = getVault();
    const ids = (vault?.list() ?? []).map((m) => m.id).filter((id) => vault.get(id)?.aiTags == null);
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
    while (queue.size && enabled() && (await ready())) {
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
    const m = vault?.get(id);
    if (!m || m.locked || m.aiTags || isOpen(id) || isBlankBody(m.body) || extractTags(m.body).length >= MAX_TAGS) return;
    const names = await tasks().autoTags(m.body, id);
    // 그사이 고쳤거나 열었으면 건드리지 않는다 (다음에 닫을 때 · 들어올 때 다시)
    if (getVault() !== vault || vault.get(id)?.body !== m.body || isOpen(id)) return;
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

  return { add, later, all, stop, clearAll, status: () => batch && { done: batch.done, total: batch.total } };
}
