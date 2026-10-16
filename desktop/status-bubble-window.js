// 메모 창 상태 줄이 잘렸을 때 전문을 보여 주는 말풍선 창 — 왕관 · 테이프 스티커처럼 메모 창 바깥에 매달린다
//   (메모 내용을 가리지 않게). 자리는 차례로:
//     above  창 위 가장자리 바깥 (꼬리가 상태 줄 글을 가리킴, 위 스티커와는 겹치지 않게 bubble.js 가 비켜 둠)
//     right  창 오른쪽 바깥, 윗막대 높이 (창이 화면 맨 위에 붙어 위에 자리가 없을 때)
//     left   창 왼쪽 바깥
//     over   창 안 윗막대 위에 겹쳐 (사방에 자리가 없을 때만 — 본문은 되도록 가리지 않게 막대에 붙여)
//   창은 메모 창마다 하나 (처음 쓸 때 만들고 그 뒤로는 숨겼다 보였다), 마우스는 통과, 입력은 뺏지 않는다.
import { BrowserWindow, screen } from 'electron';
import path from 'node:path';

import { placeBubble, BUBBLE_SIZE, BAR_H } from './bubble-place.js';

export class StatusBubbles {
  /** @param {{ appDir: string, webPreferences: object, guard?: (w: BrowserWindow) => void, stickerOf?: (owner: BrowserWindow) => object | null }} o */
  constructor({ appDir, webPreferences, guard = () => {}, stickerOf = () => null }) {
    Object.assign(this, { appDir, webPreferences, guard, stickerOf });
    this.byOwner = new Map(); // owner.id → { win, ready, pending, waiters }
  }

  where(owner, clientX) {
    const b = owner.getContentBounds();
    const zoom = owner.webContents.getZoomFactor?.() ?? 1;
    const anchor = b.x + clientX * zoom; // 상태 줄 글이 시작하는 화면 좌표
    // 모니터가 여럿이면 상태 줄이 있는 화면 (창이 두 화면에 걸쳐도 글자 쪽 화면의 작업 영역 · 배율)
    const area = screen.getDisplayNearestPoint({ x: Math.round(anchor), y: Math.round(b.y + 4) }).workArea;
    return placeBubble(b, area, anchor, BAR_H * zoom, this.stickerOf(owner));
  }

  /** 보이기 (text 가 비면 숨김) → 보였는지 (상태 줄은 말풍선이 실제로 뜬 뒤에야 감춘다) */
  show(owner, { text = '', error = false, x = 0 } = {}) {
    if (!owner || owner.isDestroyed()) return Promise.resolve(false);
    if (!text) return Promise.resolve(this.hide(owner) && false);
    // 바탕화면 층(테이프) 메모는 앞에 나와 있을 때만 — 다른 창 뒤에 있으면 말풍선만 혼자 떠 보인다
    if (owner.mkPinned && !owner.isFocused()) return Promise.resolve(false);
    let e = this.byOwner.get(owner.id);
    if (!e || e.win.isDestroyed()) e = this.create(owner);
    const spot = this.where(owner, x);
    const payload = { text: String(text).slice(0, 600), error: Boolean(error), ...spot, bounds: undefined };
    e.win.setBounds(spot.bounds);
    return new Promise((resolve) => {
      if (!e.ready) {
        e.pending = payload;
        e.waiters.push(resolve);
        return;
      }
      e.win.webContents.send('bubble:show', payload);
      if (e.win.isVisible()) return resolve(true);
      // 숨겨 둔 창은 지난 글이 남은 그림으로 먼저 보일 수 있어 새 글을 그릴 틈을 준다 (그 사이 거뒀으면 띄우지 않는다)
      const token = (e.token = (e.token ?? 0) + 1);
      e.waiters.push(resolve);
      setTimeout(() => {
        if (e.token !== token || e.win.isDestroyed() || owner.isDestroyed()) return;
        e.waiters = e.waiters.filter((w) => w !== resolve);
        e.win.showInactive();
        resolve(true);
      }, 40);
    });
  }

  hide(owner) {
    const e = owner && this.byOwner.get(owner.id);
    if (!e || e.win.isDestroyed()) return true;
    e.pending = null;
    e.token = (e.token ?? 0) + 1; // 띄우려고 기다리던 것도 그만
    for (const w of e.waiters.splice(0)) w(false);
    e.win.webContents.send('bubble:hide'); // 먼저 비우고 숨긴다 (다음에 보일 때 지난 글이 비치지 않게)
    if (e.win.isVisible()) e.win.hide();
    return true;
  }

  create(owner) {
    const win = new BrowserWindow({
      ...BUBBLE_SIZE,
      parent: owner,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: this.webPreferences,
    });
    win.setIgnoreMouseEvents(true);
    this.guard(win);
    const e = { win, ready: false, pending: null, waiters: [] };
    this.byOwner.set(owner.id, e);
    win.webContents.once('did-finish-load', () => {
      e.ready = true;
      const ok = Boolean(e.pending) && !owner.isDestroyed();
      if (ok) {
        win.webContents.send('bubble:show', e.pending);
        win.showInactive();
      }
      e.pending = null;
      for (const w of e.waiters.splice(0)) w(ok);
    });
    // 메모 창이 움직이거나 사라지면 말풍선은 거둔다 (따라다니지 않는다 — 잠깐 보이는 안내라서)
    const away = () => {
      if (!win.isVisible() && !e.pending && !e.waiters.length) return;
      this.hide(owner);
      if (!owner.isDestroyed()) owner.webContents.send('status-bubble:gone'); // 메모 창은 감춰 둔 상태 줄 글을 다시 보인다
    };
    for (const ev of ['move', 'resize', 'hide', 'minimize', 'blur']) owner.on(ev, away);
    owner.once('closed', () => {
      this.byOwner.delete(owner.id);
      if (!win.isDestroyed()) win.destroy();
    });
    win.loadFile(path.join(this.appDir, 'bubble.html'));
    return e;
  }
}
