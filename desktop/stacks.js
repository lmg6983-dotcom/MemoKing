// 메모 스택 — 여러 메모를 한 창의 탭으로 묶는다. 메모 폴더 _memoking/stacks.json 에 저장 (다른 PC 와 함께).
//   { "version": 1, "stacks": [{ "id": "…", "memos": ["메모 id", …], "active": "보이는 탭의 메모 id" }] }
// 창은 다루지 않는 순수한 저장소 (단위 테스트 대상). 창은 main.js 가 이 순서대로 만든다.
import { randomUUID } from 'node:crypto';

export class StackStore {
  /** @param {{ read: () => string|null, write: (text: string) => void, newId?: () => string }} io */
  constructor({ read, write, newId = () => randomUUID().slice(0, 8) }) {
    this.read = read;
    this.write = write;
    this.newId = newId;
    this.stacks = [];
  }

  /** 파일에서 읽고, 없어진 메모·겹친 메모를 정리한다. exists: 메모가 아직 있는지 */
  load(exists = () => true) {
    let data = null;
    try {
      data = JSON.parse(this.read() ?? 'null');
    } catch {
      // 깨진 파일 → 빈 스택
    }
    const seen = new Set();
    this.stacks = (Array.isArray(data?.stacks) ? data.stacks : [])
      .map((s) => {
        const memos = (Array.isArray(s?.memos) ? s.memos : [])
          .filter((id) => typeof id === 'string' && exists(id) && !seen.has(id) && seen.add(id));
        return { id: String(s?.id || this.newId()), memos, active: memos.includes(s?.active) ? s.active : memos[0] };
      })
      .filter((s) => s.memos.length >= 2);
    return this;
  }

  save() {
    this.write(JSON.stringify({ version: 1, stacks: this.stacks }, null, 1));
  }

  all() {
    return this.stacks;
  }

  stackOf(id) {
    return this.stacks.find((s) => s.memos.includes(id)) ?? null;
  }

  /**
   * moving 메모들(과 그 스택 전체)을 target 의 스택으로 옮긴다. target 이 혼자면 새 스택.
   * 옮겨 온 탭은 target 탭 바로 뒤에 들어가고, activate 가 보이는 탭이 된다.
   */
  merge(targetId, movingIds, { activate = movingIds[0] } = {}) {
    const moving = [];
    const targetStack = this.stackOf(targetId);
    for (const id of movingIds) {
      const from = this.stackOf(id);
      // 다른 스택이면 탭을 모두, 같은 스택 안이면 그 탭만 옮긴다
      const group = from && from !== targetStack ? from.memos : [id];
      for (const m of group) if (m !== targetId && !moving.includes(m)) moving.push(m);
    }
    for (const m of moving) this.#detach(m);
    let target = this.stackOf(targetId);
    if (!target) {
      this.#detach(targetId);
      target = { id: this.newId(), memos: [targetId], active: targetId };
      this.stacks.push(target);
    }
    const at = target.memos.indexOf(targetId) + 1;
    target.memos.splice(at, 0, ...moving);
    if (target.memos.includes(activate)) target.active = activate;
    this.#cleanup();
    this.save();
    return this.stackOf(targetId);
  }

  /** 보이는 탭 바로 뒤에 새 메모 (+ 버튼) */
  addAfter(existingId, newId) {
    let stack = this.stackOf(existingId);
    if (!stack) {
      stack = { id: this.newId(), memos: [existingId], active: existingId };
      this.stacks.push(stack);
    }
    this.#detach(newId);
    stack.memos.splice(stack.memos.indexOf(existingId) + 1, 0, newId);
    stack.active = newId;
    this.save();
    return stack;
  }

  setActive(id) {
    const stack = this.stackOf(id);
    if (!stack || stack.active === id) return stack;
    stack.active = id;
    this.save();
    return stack;
  }

  /** 옆 탭 (dir = 1 다음, -1 이전, 끝에서 처음으로 돈다) */
  neighbor(id, dir = 1) {
    const stack = this.stackOf(id);
    if (!stack) return null;
    const i = stack.memos.indexOf(id);
    return stack.memos[(i + dir + stack.memos.length) % stack.memos.length];
  }

  /**
   * 스택에서 뺀다. 보이던 탭이면 옆 탭이 보이게 된다.
   * @returns {{ stack: object|null, dissolved: boolean, nextActive: string|null }} 남은 스택 (하나만 남으면 풀림)
   */
  remove(id) {
    const stack = this.stackOf(id);
    if (!stack) return { stack: null, dissolved: false, nextActive: null };
    const i = stack.memos.indexOf(id);
    stack.memos.splice(i, 1);
    if (stack.active === id) stack.active = stack.memos[Math.min(i, stack.memos.length - 1)] ?? null;
    const dissolved = stack.memos.length < 2;
    const nextActive = stack.active;
    this.#cleanup();
    this.save();
    return { stack: dissolved ? null : stack, dissolved, nextActive, rest: stack.memos.slice() };
  }

  #detach(id) {
    for (const s of this.stacks) {
      const i = s.memos.indexOf(id);
      if (i < 0) continue;
      s.memos.splice(i, 1);
      if (s.active === id) s.active = s.memos[Math.min(i, s.memos.length - 1)];
    }
  }

  #cleanup() {
    this.stacks = this.stacks.filter((s) => s.memos.length >= 2);
  }
}
