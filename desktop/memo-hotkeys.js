// 메모 단축키 (Ctrl+Alt+1~9) — 정해 둔 칸만 전역 단축키로 잡는다 (비어 있는 칸은 다른 앱이 쓰게 둔다)
//   누르면 onPress(칸). 칸 정하기 · 상태는 메모 창의 "단축키로 불러오기" 창에서 (ipc 'hotkey:*')
import { globalShortcut } from 'electron';
import { HOTKEY_SLOTS, hotkeyAccelerator, hotkeyLabel, normalizeHotkeys, assignHotkey, slotOf } from '../app/js/core/memo-hotkeys.js';

export class MemoHotkeys {
  /**
   * @param {{ settings: object, saveSettings: () => void, getVault: () => any, onPress: (slot: string) => void,
   *           reserved?: () => { key: string, name: string }[] }} o reserved: 메모킹의 다른 전역 단축키 (빠른 메모 · 매직키)
   */
  constructor({ settings, saveSettings, getVault, onPress, reserved = () => [] }) {
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.getVault = getVault;
    this.onPress = onPress;
    this.reserved = reserved;
    this.held = new Map(); // 칸 → 잡은 단축키
    this.failed = new Set(); // 다른 앱이 쓰고 있어 잡지 못한 칸
    this.paused = false;
    this.cachedFrom = Symbol('아직 없음'); // map 캐시: 이 설정 값으로 만든 것
  }

  /** 정리한 칸들 (설정 값이 바뀔 때만 다시 — 목록을 그릴 때마다 메모 수만큼 불린다) */
  get map() {
    if (this.cachedFrom !== this.settings.memoHotkeys) {
      this.cachedFrom = this.settings.memoHotkeys;
      this.cached = normalizeHotkeys(this.cachedFrom);
      this.slotById = new Map(Object.entries(this.cached).map(([slot, b]) => [b.id, slot]));
    }
    return this.cached;
  }

  /** 다른 메모킹 단축키가 쓰는 칸이면 그 이름 */
  reservedBy(slot) {
    return this.reserved().find((r) => r.key === hotkeyAccelerator(slot))?.name ?? null;
  }

  register() {
    this.unregister();
    this.failed.clear();
    if (this.paused) return;
    const vault = this.getVault();
    for (const [slot, b] of Object.entries(this.map)) {
      // 없는 메모(다른 기기에서 지움 · 다른 폴더)의 칸은 잡지 않는다 — 다른 앱이 쓰게. 메모가 돌아오면 다시 (refresh)
      if (vault && !vault.get(b.id)) continue;
      if (this.reservedBy(slot)) {
        this.failed.add(slot);
        continue;
      }
      const acc = hotkeyAccelerator(slot);
      let ok = false;
      try {
        ok = globalShortcut.register(acc, () => this.onPress(slot));
      } catch {
        ok = false;
      }
      if (ok) this.held.set(slot, acc);
      else {
        this.failed.add(slot);
        console.warn(`${hotkeyLabel(slot)} 를 다른 프로그램이 쓰고 있어 등록하지 못했습니다`);
      }
    }
  }

  /** 메모가 생기거나 없어졌으면 잡은 키를 다시 맞춘다 (메모 폴더가 바뀔 때 · 다른 기기에서 지웠을 때) */
  refresh() {
    const vault = this.getVault();
    const want = Object.entries(this.map).filter(([slot, b]) => !this.reservedBy(slot) && (!vault || vault.get(b.id))).map(([slot]) => slot);
    if (want.some((slot) => !this.held.has(slot) && !this.failed.has(slot)) || [...this.held.keys()].some((slot) => !want.includes(slot))) this.register();
  }

  unregister() {
    for (const acc of this.held.values()) globalShortcut.unregister(acc);
    this.held.clear();
  }

  /** 단축키를 바꾸는 동안(설정 › 단축키) 잠시 놓기 */
  pause(on) {
    this.paused = Boolean(on);
    this.register();
  }

  /** 메모 창의 "단축키로 불러오기" 창에 보일 상태 */
  state(id) {
    const map = this.map;
    const vault = this.getVault();
    const mine = slotOf(map, id);
    return {
      slot: mine,
      copy: mine ? map[mine].copy : true,
      show: mine ? map[mine].show : false,
      slots: HOTKEY_SLOTS.map((slot) => {
        const b = map[slot];
        const other = b && b.id !== id ? vault?.get(b.id) : null;
        return {
          slot,
          label: hotkeyLabel(slot),
          mine: b?.id === id,
          // 다른 메모가 쓰는 칸: 그 메모 제목 (지워진 메모면 빈 칸처럼)
          title: other ? other.title || '제목 없음' : null,
          reserved: this.reservedBy(slot),
          failed: this.failed.has(slot) && !this.reservedBy(slot),
        };
      }),
    };
  }

  /** 칸 정하기 (slot 이 null 이면 풀기) → { ok, error?, state } */
  set(id, slot, { copy = true, show = false } = {}) {
    if (slot != null && this.reservedBy(slot)) return { ok: false, error: `${hotkeyLabel(slot)} 는 ${this.reservedBy(slot)} 단축키라 쓸 수 없어요`, state: this.state(id) };
    let next;
    try {
      next = assignHotkey(this.map, id, slot, { copy, show }).hotkeys;
    } catch (err) {
      return { ok: false, error: err.message, state: this.state(id) };
    }
    // 단축키를 바꾸는 중(잠시 놓음)이면 잡아 보고 바로 놓아 다른 앱이 쓰는지만 본다
    if (slot != null && this.paused) {
      const acc = hotkeyAccelerator(slot);
      let free = false;
      try {
        free = globalShortcut.register(acc, () => {});
      } catch {
        free = false;
      }
      if (free) globalShortcut.unregister(acc);
      else return { ok: false, error: `${hotkeyLabel(slot)} 는 다른 앱이 이미 쓰고 있어요. 다른 숫자를 골라 주세요`, state: this.state(id) };
    }
    const before = this.settings.memoHotkeys;
    this.settings.memoHotkeys = next;
    this.register();
    if (slot != null && !this.held.has(String(slot)) && !this.paused) {
      // 다른 앱이 이미 쓰는 키 — 예전대로 되돌린다
      this.settings.memoHotkeys = before;
      this.register();
      return { ok: false, error: `${hotkeyLabel(slot)} 는 다른 앱이 이미 쓰고 있어요. 다른 숫자를 골라 주세요`, state: this.state(id) };
    }
    this.saveSettings();
    return { ok: true, state: this.state(id) };
  }

  /** 메모 id → 칸 (목록 카드에 표시) */
  slotOf(id) {
    void this.map;
    return this.slotById.get(id) ?? null;
  }
}
