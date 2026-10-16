// 메모 창 상태 줄이 잘렸을 때 전문을 보여 주는 말풍선 창 — 왕관 · 테이프 스티커처럼 메모 창 위 가장자리 바깥에 매달린다
//   (메모 내용을 가리지 않게). 화면 위쪽에 자리가 없으면 창 안 윗막대 바로 밑에.
//   창은 메모 창마다 하나 (처음 쓸 때 만들고 그 뒤로는 숨겼다 보였다), 마우스는 통과, 입력은 뺏지 않는다.
import { BrowserWindow, screen } from 'electron';
import path from 'node:path';

export const BUBBLE_SIZE = { width: 360, height: 180 }; // 투명한 곳은 보이지도 눌리지도 않는다
const BAR_H = 36; // 메모 창 윗막대

export class StatusBubbles {
  /** @param {{ appDir: string, webPreferences: object, guard?: (w: BrowserWindow) => void, stickerOf?: (owner: BrowserWindow) => boolean }} o */
  constructor({ appDir, webPreferences, guard = () => {}, stickerOf = () => false }) {
    Object.assign(this, { appDir, webPreferences, guard, stickerOf });
    this.byOwner = new Map(); // owner.id → { win, ready, pending }
  }

  /** 자리: 위에 매달 수 있으면 above (창 아래쪽이 메모 창 위 가장자리에서 조금 떨어지게) */
  bounds(owner, clientX) {
    const b = owner.getContentBounds();
    const zoom = owner.webContents.getZoomFactor?.() ?? 1;
    const area = screen.getDisplayMatching(b).workArea;
    const anchor = b.x + clientX * zoom; // 상태 줄 글이 시작하는 화면 좌표
    const x = Math.round(Math.max(area.x, Math.min(anchor - 24, area.x + area.width - BUBBLE_SIZE.width)));
    const lift = this.stickerOf(owner) ? 26 : 2; // 가운데 위 스티커(반쯤 밖으로 나온)와 겹치지 않게
    const aboveY = b.y - lift - BUBBLE_SIZE.height;
    const above = aboveY >= area.y;
    const y = Math.round(above ? aboveY : b.y + BAR_H * zoom - 2);
    // 꼬리 자리(창 안 좌표) — 말풍선을 어디에 둘지는 글 너비를 아는 bubble.js 가 정한다
    return { bounds: { x, y, ...BUBBLE_SIZE }, above, anchor: anchor - x + 10 };
  }

  /** 보이기 (text 가 비면 숨김) */
  show(owner, { text = '', error = false, x = 0 } = {}) {
    if (!owner || owner.isDestroyed()) return;
    if (!text) return this.hide(owner);
    let e = this.byOwner.get(owner.id);
    if (!e || e.win.isDestroyed()) e = this.create(owner);
    const { bounds, above, anchor } = this.bounds(owner, x);
    const payload = { text: String(text).slice(0, 600), error: Boolean(error), above, anchor };
    e.win.setBounds(bounds);
    if (!e.ready) {
      e.pending = payload;
      return;
    }
    e.win.webContents.send('bubble:show', payload);
    // 숨겨 둔 창은 지난 글이 남은 그림으로 먼저 보일 수 있어 새 글을 그릴 틈을 준다
    if (!e.win.isVisible()) setTimeout(() => !e.win.isDestroyed() && !owner.isDestroyed() && e.win.showInactive(), 40);
  }

  hide(owner) {
    const e = owner && this.byOwner.get(owner.id);
    if (!e || e.win.isDestroyed()) return;
    e.pending = null;
    e.win.webContents.send('bubble:hide'); // 먼저 비우고 숨긴다 (다음에 보일 때 지난 글이 비치지 않게)
    if (e.win.isVisible()) e.win.hide();
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
    const e = { win, ready: false, pending: null };
    this.byOwner.set(owner.id, e);
    win.webContents.once('did-finish-load', () => {
      e.ready = true;
      if (e.pending && !owner.isDestroyed()) {
        win.webContents.send('bubble:show', e.pending);
        win.showInactive();
      }
      e.pending = null;
    });
    // 메모 창이 움직이거나 사라지면 말풍선은 거둔다 (따라다니지 않는다 — 잠깐 보이는 안내라서)
    const away = () => this.hide(owner);
    for (const ev of ['move', 'resize', 'hide', 'minimize']) owner.on(ev, away);
    owner.once('closed', () => {
      this.byOwner.delete(owner.id);
      if (!win.isDestroyed()) win.destroy();
    });
    win.loadFile(path.join(this.appDir, 'bubble.html'));
    return e;
  }
}
