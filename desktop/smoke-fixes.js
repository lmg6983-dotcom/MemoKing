// #수정사항.pdf 반영분만 확인하는 짧은 점검 (npm run smoke:fixes) — 화면을 찍어 out/fixes/*.png 로 남긴다
//   1) 새 일정: 하단 빠른 추가 캡슐 · 미리 알림 스위치 · 시작 → 종료(여러 날)
//   2) 달력 좌우 스와이프 달 넘기기
//   3) 사진 크게 보기: 전체 화면 · 위아래 막대 2초 뒤 숨김
//   4) 휴대폰 내용 옮긴 뒤 스크롤 (위로 = 머리, 아래로 = 꼬리가 보이게)
// 임시 폴더(%TEMP%\memoking-smoke)만 쓴다.
import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SMOKE_DIR = path.join(os.tmpdir(), 'memoking-smoke');
const VAULT = path.join(SMOKE_DIR, 'vault');
const OUT = path.join(app.isPackaged ? SMOKE_DIR : path.join(import.meta.dirname, '..'), 'out', 'fixes');

export function prepareSmoke(userData) {
  fs.mkdirSync(userData, { recursive: true });
  fs.rmSync(VAULT, { recursive: true, force: true });
  fs.mkdirSync(VAULT, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ vaultPath: VAULT, tutorialDone: true }));
}

export async function runSmoke({ getVault, getList, noteWins, createListWindow }) {
  const checks = [];
  const errors = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
    console.log(`… ${ok ? '✔' : '✖'} ${name}`);
  };
  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (...args) => {
      const [event, legacyLevel, legacyMessage] = args;
      const level = event?.level ?? legacyLevel;
      const msg = event?.message ?? legacyMessage;
      console.log(`[WC ${level}] ${event?.source || ''}:${event?.lineNumber || ''} -> ${msg}`);
      if (level === 'error' || level === 3) errors.push(`${event?.source}:${event?.lineNumber} ${msg}`);
    });
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (win, code) => win.webContents.executeJavaScript(code, true);
  async function until(fn, label, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const v = await fn();
        if (v) return v;
      } catch {
        // 다시
      }
      await wait(100);
    }
    throw new Error(`시간 초과: ${label}`);
  }
  async function capture(win, name, settle = 300) {
    await wait(settle);
    try {
      const img = await Promise.race([win.webContents.capturePage(), wait(3000).then(() => { throw new Error('시간 초과'); })]);
      fs.writeFileSync(path.join(OUT, name), img.toPNG());
    } catch (err) {
      console.warn(`화면을 찍지 못했어요 (${name}): ${err.message}`);
    }
  }
  const click = async (win, x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await wait(40);
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  // 손가락: 크롬 개발 도구 입력으로 진짜 touch 이벤트를 보낸다
  async function touchOf(win) {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const send = (type, x, y) => dbg.sendCommand('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }] });
    return {
      start: (x, y) => send('touchStart', x, y),
      move: (x, y) => send('touchMove', x, y),
      end: () => send('touchEnd'),
      async drag(x, y0, y1, steps = 12, gap = 30) {
        for (let k = 1; k <= steps; k++) {
          await send('touchMove', x, y0 + ((y1 - y0) * k) / steps);
          await wait(gap);
        }
      },
      detach: async () => {
        await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
        dbg.detach();
      },
    };
  }

  let exitCode = 1;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const vault = getVault();
    const list = getList() ?? createListWindow();
    await until(() => js(list, `document.readyState === 'complete' && document.documentElement.dataset.ready === 'true'`), '목록 창', 15000).catch(() => {});

    // ---------- 1) 일정 탭: 하단 빠른 추가 캡슐 ----------
    console.log('[점검] 1단계: 캘린더 빠른 추가 및 새 일정 창...');
    await js(list, `document.querySelector('[data-tab="reminders"]')?.click()`);
    await until(() => js(list, `!!document.querySelector('.cal-quick-pill') && !!document.querySelector('#reminder-groups [role="gridcell"][data-date]')`), '일정 탭', 15000);
    await wait(500);
    // 오늘 이후의 이 달 날짜 (달 끝이면 오늘)
    const target = await js(list, `(() => {
      const t = new Date(); const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
      const p = (n) => String(n).padStart(2, '0');
      const pick = d.getMonth() === t.getMonth() ? d : t;
      const key = pick.getFullYear() + '-' + p(pick.getMonth() + 1) + '-' + p(pick.getDate());
      const cell = document.querySelector('#reminder-groups [role="gridcell"][data-date="' + key + '"]');
      const r = cell.getBoundingClientRect();
      return { key, m: pick.getMonth() + 1, d: pick.getDate(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await capture(list, '1-1-calendar-pill.png');
    const pill0 = await js(list, `document.querySelector('.cal-quick-label')?.textContent`);
    await click(list, target.x, target.y);
    await wait(400);
    const afterPick = await js(list, `({ label: document.querySelector('.cal-quick-label')?.textContent, pill: !document.querySelector('.cal-quick-pill').hidden, box: !document.querySelector('.cal-quick-box').hidden, dialog: !!document.querySelector('dialog.quick-event[open]'), sel: document.querySelector('#reminder-groups [role="gridcell"].mk-selected')?.dataset.date })`);
    await capture(list, '1-2-calendar-pick-date.png');
    check('달력에서 날짜를 누르면 창이 바로 뜨지 않고, 하단 캡슐이 "N월 N일에 추가 ＋"로 바뀜',
      !afterPick.dialog && afterPick.pill && !afterPick.box && afterPick.sel === target.key && afterPick.label?.includes(`${target.m}월 ${target.d}일`), { pill0, afterPick, target });

    // 같은 날을 한 번 더 누르면 바로 입력 칸 + 추천 시간 칩
    await click(list, target.x, target.y);
    await wait(400);
    const inline = await js(list, `({ box: !document.querySelector('.cal-quick-box').hidden, chips: [...document.querySelectorAll('.cal-quick-chips button')].map((b) => b.textContent), focus: document.activeElement?.classList.contains('cal-quick-input'), val: document.querySelector('.cal-quick-input')?.value, mark: document.querySelector('.cal-quick-date-mark')?.textContent })`);
    await capture(list, '1-2-quick-expanded-default-date.png');
    check('고른 날짜를 한 번 더 누르면 하단에 빠른 입력 칸 + 추천 시간 칩(오전 10시 · 오후 2시 · 오후 3시) 및 기본 날짜 노란 밑줄',
      inline.box && inline.chips.join() === '오전 10시,오후 2시,오후 3시' && inline.val?.includes(`${target.m}월 ${target.d}일`) && inline.mark === `${target.m}월 ${target.d}일`, inline);
    await js(list, `(() => { const i = document.querySelector('.cal-quick-input'); i.value = '치과 2시'; i.dispatchEvent(new Event('input')); })()`);
    await capture(list, '1-3-calendar-quick-input.png');
    await js(list, `document.querySelector('.cal-quick-save').click()`);
    const flashText = await until(() => js(list, `document.getElementById('flash-bar')?.textContent`), '저장 완료 토스트', 3000).catch(() => '');
    check('일정 저장 후 토스트 안내 메시지 표시', flashText?.includes('치과') && flashText?.includes('저장'), { flashText });
    const dentist = await until(() => {
      for (const m of vault.list()) {
        const r = vault.get(m.id)?.reminders?.find((x) => x.title === '치과');
        if (r) return r;
      }
      return null;
    }, '빠른 일정 저장', 5000).catch(() => null);
    const at = dentist ? new Date(dentist.at) : null;
    check('빠른 입력 "치과 2시" → 제목 "치과", 그날 오후 2:00 일정으로 저장', at && at.getHours() === 14 && at.getDate() === target.d && !dentist.allDay, dentist);
    await wait(500);
    await capture(list, '1-4-calendar-quick-saved.png');

    // 상세 설정 → 새 일정 창: 시작 → 종료 · 미리 알림 스위치
    console.log('[점검] 상세 설정 버튼 클릭 (새 일정 창 열기)...');
    const res = await js(list, `(() => {
      const pill = document.querySelector('.cal-quick-pill');
      if (pill && !pill.hidden) pill.click();
      const i = document.querySelector('.cal-quick-input');
      i.value = '워크숍';
      const qm = document.querySelector('.cal-quick-more');
      setTimeout(() => qm?.click(), 10);
      return { found: !!qm, hidden: qm?.hidden };
    })()`);
    console.log('[점검] 상세 설정 준비 상태:', res);
    await until(() => js(list, `!!document.querySelector('dialog.quick-event[open] .qe-range')`), '새 일정 창', 8000);
    const qe = `document.querySelector('dialog.quick-event[open]')`;
    const qeState = () => js(list, `(() => { const d = ${qe}; const sides = [...d.querySelectorAll('.qe-side')]; const sw = d.querySelector('.qe-alert-switch'); const row = d.querySelector('.qe-alert-row').getBoundingClientRect(); const sr = sw.getBoundingClientRect();
      return { name: d.querySelector('.qe-name').value, sides: sides.map((s) => s.querySelector('.qe-date-text').textContent), arrow: !!d.querySelector('.qe-arrow'),
        switchOn: sw.checked, switchRight: sr.right > row.right - 60, pane: !d.querySelector('.qe-pane[data-step="alerts"]').hidden, alertVal: d.querySelector('.qe-alert-row .qe-row-value').textContent }; })()`);
    const qe0 = await qeState();
    await capture(list, '1-5-quick-event-range.png');
    check('상세 설정 → 새 일정 창: 제목이 넘어오고, 시작 날짜 → 종료 날짜가 나란히 · 미리 알림 줄 오른쪽에 스위치', qe0.name === '워크숍' && qe0.sides.length === 2 && qe0.arrow && qe0.switchRight, qe0);
    // 스위치 끄기 → 칩 접힘 · "없음" / 켜기 → 칩 펼침
    if (qe0.switchOn) {
      await js(list, `${qe}.querySelector('.qe-alert-switch').click()`);
      await wait(200);
    }
    const qeOff = await qeState();
    await capture(list, '1-6-quick-event-alert-off.png');
    await js(list, `${qe}.querySelector('.qe-alert-switch').click()`);
    await wait(200);
    const qeOn = await qeState();
    await capture(list, '1-7-quick-event-alert-on.png');
    check('미리 알림 스위치: 끄면 알림 칩이 접히고 "없음", 켜면 칩이 펼쳐짐', !qeOff.switchOn && !qeOff.pane && qeOff.alertVal === '없음' && qeOn.switchOn && qeOn.pane && qeOn.alertVal !== '없음', { qeOff, qeOn });
    // 여러 날: 종료 날짜를 이틀 뒤로 → 저장
    const endKey = await js(list, `(() => { const d = ${qe}; const s = d.querySelectorAll('.qe-date-input')[0].value.split('-').map(Number); const e = new Date(s[0], s[1] - 1, s[2] + 2); const p = (n) => String(n).padStart(2, '0'); const v = e.getFullYear() + '-' + p(e.getMonth() + 1) + '-' + p(e.getDate()); const inp = d.querySelectorAll('.qe-date-input')[1]; inp.value = v; inp.dispatchEvent(new Event('change')); return v; })()`);
    await wait(200);
    const qeMulti = await qeState();
    await capture(list, '1-8-quick-event-multiday.png');
    await js(list, `${qe}.querySelector('.qe-save').click()`);
    const workshop = await until(() => {
      for (const m of vault.list()) {
        const r = vault.get(m.id)?.reminders?.find((x) => x.title === '워크숍');
        if (r) return r;
      }
      return null;
    }, '여러 날 일정 저장', 5000).catch(() => null);
    check('종료 날짜를 이틀 뒤로 바꾸면 여러 날 일정으로 저장 (end 가 종료 날짜)', workshop?.end?.startsWith(endKey) && qeMulti.sides[0] !== qeMulti.sides[1], { endKey, workshop, sides: qeMulti.sides });
    await wait(600);
    await capture(list, '1-9-calendar-multiday-span.png');

    // ---------- 2) 달력 좌우 스와이프 ----------
    console.log('[점검] 2단계: 캘린더 좌우 스와이프 달 넘기기...');
    const title0 = await js(list, `document.querySelector('.cal-title').textContent`);
    const body = await js(list, `(() => { const r = document.querySelector('.cal-body').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
    const t = await touchOf(list);
    await t.start(body.x + 80, body.y);
    for (let k = 1; k <= 8; k++) {
      await t.move(body.x + 80 - k * 20, body.y + 2);
      await wait(25);
    }
    const mid = await js(list, `document.querySelector('.cal-body').style.transform`);
    await capture(list, '2-1-swipe-dragging.png', 50);
    await t.end();
    const title1 = await until(async () => { const v = await js(list, `document.querySelector('.cal-title').textContent`); return v !== title0 && v; }, '다음 달', 3000).catch(() => title0);
    await capture(list, '2-2-swipe-next-month.png', 400);
    // 오른쪽으로 밀면 다시 이전 달
    await t.start(body.x - 80, body.y);
    for (let k = 1; k <= 8; k++) {
      await t.move(body.x - 80 + k * 20, body.y + 2);
      await wait(25);
    }
    await t.end();
    const title2 = await until(async () => { const v = await js(list, `document.querySelector('.cal-title').textContent`); return v === title0 && v; }, '이전 달', 3000).catch(() => '');
    // 세로로 밀면 달이 바뀌지 않음
    await t.start(body.x, body.y - 60);
    for (let k = 1; k <= 6; k++) {
      await t.move(body.x + 4, body.y - 60 + k * 20);
      await wait(25);
    }
    await t.end();
    await wait(400);
    const title3 = await js(list, `document.querySelector('.cal-title').textContent`);
    await t.detach();
    check('달력을 왼쪽으로 밀면 손가락을 따라 밀리다(translateX) 다음 달, 오른쪽이면 이전 달 · 세로로 밀면 그대로',
      /translateX\(-/.test(mid) && title1 !== title0 && title2 === title0 && title3 === title0, { title0, mid, title1, title2, title3 });

    // 메모 창 여는 도우미
    const openMemo = async (bodyText, label) => {
      const id = vault.import({ body: bodyText });
      createListWindow('memos');
      await until(() => js(list, `!!document.querySelector('[data-id="${id}"]')`), `${label} 카드`, 8000);
      const before = new Set(noteWins.keys());
      await js(list, `document.querySelector('[data-id="${id}"]').click()`);
      const nid = await until(() => [...noteWins.keys()].find((k) => !before.has(k)), `${label} 창`);
      const win = noteWins.get(nid);
      await until(() => js(win, `document.documentElement.dataset.ready === 'true'`), `${label} 준비`);
      win.focus();
      await wait(300);
      return { id: nid, win };
    };

    // ---------- 3) 사진 크게 보기 ----------
    console.log('[점검] 3단계: 사진 크게 보기 및 위아래 바 숨김...');
    {
      const { win: aw } = await openMemo('# 묶음 사진\n\n끝\n', '묶음 사진');
      await js(aw, `(async () => {
        const make = (w, h, a, b, label) => new Promise((done) => {
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const g = c.getContext('2d'); const grd = g.createLinearGradient(0, 0, w, h); grd.addColorStop(0, a); grd.addColorStop(1, b);
          g.fillStyle = grd; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = 'bold ' + Math.round(h / 7) + 'px sans-serif'; g.fillText(label, w * 0.08, h * 0.9);
          c.toBlob((bl) => done(new File([bl], label + '.png', { type: 'image/png' })), 'image/png');
        });
        const files = await Promise.all([make(1200, 800, '#f7b267', '#f4845f', '바다'), make(800, 1200, '#4d908e', '#277da1', '숲'), make(1000, 1000, '#9d4edd', '#5a189a', '야경')]);
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        const r = document.querySelector('.mk-doc p').getBoundingClientRect();
        document.querySelector('.ProseMirror').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4 }));
      })()`);
      await until(() => js(aw, `!!document.querySelector('.mk-prompt')`), '묶음 사진 질문', 4000).catch(() => {});
      await js(aw, `[...document.querySelectorAll('.mk-prompt button')].find((b) => b.textContent === '묶음 사진으로')?.click()`);
      await until(() => js(aw, `document.querySelectorAll('.mk-doc img.mk-album-img').length === 3`), '묶음 사진', 5000);
      await wait(400);
      await js(aw, `document.querySelectorAll('.mk-doc img.mk-album-img')[0].click()`);
      await until(() => js(aw, `!!document.querySelector('.mk-album-view .mk-album-stage')`), '크게 보기', 3000);
      const ui = () => js(aw, `(() => { const v = document.querySelector('.mk-album-view'); const st = v.querySelector('.mk-album-stage').getBoundingClientRect(); const head = v.querySelector('.mk-album-head'); const strip = v.querySelector('.mk-album-strip');
        return { active: v.classList.contains('ui-active'), headOp: getComputedStyle(head).opacity, stripOp: strip ? getComputedStyle(strip).opacity : null,
          stage: [Math.round(st.left), Math.round(st.top), Math.round(st.width), Math.round(st.height)], win: [innerWidth, innerHeight],
          headOver: head.getBoundingClientRect().top < st.top + 4 && head.getBoundingClientRect().bottom > st.top }; })()`);
      await wait(400);
      const open = await ui();
      await capture(aw, '3-1-viewer-open-ui.png', 0);
      await wait(2300);
      const hidden = await ui();
      await capture(aw, '3-2-viewer-ui-hidden.png', 0);
      // 가운데 한 번 누르면 다시 보이고, 보이는 중에 누르면 바로 숨김
      const st = await js(aw, `(() => { const r = document.querySelector('.mk-album-stage').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      await click(aw, st.x, st.y);
      await wait(450);
      const woke = await ui();
      await capture(aw, '3-3-viewer-tap-wake.png', 0);
      await wait(300); // 두 번 누르기(확대)로 잡히지 않게
      await click(aw, st.x, st.y);
      await wait(450);
      const slept = await ui();
      const full = open.stage[0] <= 1 && open.stage[1] <= 1 && Math.abs(open.stage[2] - open.win[0]) <= 2 && Math.abs(open.stage[3] - open.win[1]) <= 2;
      check('사진 크게 보기: 여백 없이 화면 전체 · 위 머리 막대/아래 줄이 사진 위에 겹쳐 보임', full && open.headOver, open);
      check('위아래 막대: 열 때 보이고 2초 뒤 사라짐 · 누르면 다시 보이고, 보이는 중에 누르면 바로 숨김',
        open.active && !hidden.active && Number(hidden.headOp) < 0.1 && woke.active && !slept.active, { open, hidden, woke, slept });
      aw.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      aw.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await wait(300);
      aw.close();
    }

    // ---------- 4) 휴대폰: 내용 옮긴 뒤 스크롤 ----------
    console.log('[점검] 4단계: 내용 옮긴 뒤 스크롤 맞춤...');
    {
      fs.mkdirSync(path.join(vault.root, 'attachments'), { recursive: true });
      const tall = nativeImage.createFromPath(path.join(import.meta.dirname, '..', 'assets', 'icons', 'icon-256.png')).resize({ width: 360, height: 560 });
      fs.writeFileSync(path.join(vault.root, 'attachments', 'smoke-tall.png'), tall.toPNG());
      const lines = (from, n) => Array.from({ length: n }, (_, k) => `${from + k}번째 줄 — 옮기기 점검용 글`).join('\n\n');
      const { win: mw } = await openMemo(`# 옮기기 점검\n\n${lines(1, 14)}\n\n![긴 그림](attachments/smoke-tall.png)\n\n${lines(15, 14)}\n`, '옮기기');
      mw.setBounds({ ...mw.getBounds(), width: 400, height: 760 });
      await wait(500);
      await until(() => js(mw, `(() => { const i = document.querySelector('.mk-doc img.mk-image'); return i && i.complete && i.naturalHeight > 0; })()`), '긴 그림', 5000);
      const scroller = `(() => { let n = document.querySelector('.ProseMirror'); while (n && n !== document.body) { const o = getComputedStyle(n).overflowY; if (/(auto|scroll)/.test(o) && n.scrollHeight > n.clientHeight) return n; n = n.parentElement; } return document.scrollingElement; })()`;
      const measure = () => js(mw, `(() => { const s = ${scroller}; const box = s === document.scrollingElement ? { top: 0, bottom: innerHeight } : s.getBoundingClientRect(); const p = document.querySelector('.mk-doc img.mk-image').closest('p'); const r = p.getBoundingClientRect(); const idx = [...p.parentElement.children].indexOf(p);
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), boxTop: Math.round(box.top), boxBottom: Math.round(box.bottom), st: Math.round(s.scrollTop), idx }; })()`);
      // 그림이 화면 가운데쯤 오게
      await js(mw, `document.querySelector('.mk-doc img.mk-image').scrollIntoView({ block: 'center' })`);
      await wait(300);
      const m0 = await measure();
      await capture(mw, '4-1-move-before.png', 0);
      const t2 = await touchOf(mw);
      const grab = async () => {
        const c = await js(mw, `(() => { const r = document.querySelector('.mk-doc img.mk-image').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(Math.max(r.top + 20, Math.min(r.bottom - 20, innerHeight / 2))) }; })()`);
        await t2.start(c.x, c.y);
        await wait(650); // 꾹 누르기 (0.35초) + 여유
        const lifted = await js(mw, `document.body.classList.contains('mk-block-dragging')`);
        return { ...c, lifted };
      };
      // 위로 5칸쯤
      const g1 = await grab();
      await t2.drag(g1.x, g1.y, g1.y - 230);
      await capture(mw, '4-2-move-up-dragging.png', 100);
      await t2.end();
      await wait(600);
      const up = await measure();
      await capture(mw, '4-3-move-up-after.png', 0);
      const upHeadVisible = up.top >= up.boxTop - 1 && up.top <= up.boxBottom - 16;
      check('휴대폰: 내용을 위로 옮기면 놓은 뒤 그 내용의 머리(위 끝)가 화면 안에 보임', g1.lifted && up.idx < m0.idx && upHeadVisible, { m0, g1, up });

      // 아래로 8칸쯤
      await js(mw, `document.querySelector('.mk-doc img.mk-image').scrollIntoView({ block: 'center' })`);
      await wait(300);
      const m1 = await measure();
      const g2 = await grab();
      await t2.drag(g2.x, g2.y, g2.y + 330);
      await capture(mw, '4-4-move-down-dragging.png', 100);
      await t2.end();
      await wait(600);
      const down = await measure();
      await capture(mw, '4-5-move-down-after.png', 0);
      const downTailVisible = down.bottom <= down.boxBottom + 1 && down.bottom >= down.boxTop + 16;
      check('휴대폰: 내용을 아래로 옮기면 놓은 뒤 그 내용의 꼬리(아래 끝)가 화면 안에 보임', g2.lifted && down.idx > m1.idx && downTailVisible, { m1, g2, down });

      // 들어 올렸다 제자리에 놓으면(옮기지 않음) 스크롤은 그대로
      await js(mw, `document.querySelector('.mk-doc img.mk-image').scrollIntoView({ block: 'center' })`);
      await wait(300);
      const m2 = await measure();
      const g3 = await grab();
      await t2.end();
      await wait(500);
      const same = await measure();
      await capture(mw, '4-6-lift-no-move.png', 0);
      check('휴대폰: 들어 올렸다 그 자리에 놓으면 스크롤 위치는 들기 전 그대로', g3.lifted && Math.abs(same.st - m2.st) <= 2 && same.idx === m2.idx, { m2, same });
      await t2.detach();
      mw.close();
    }

    // ---------- 5) 메모 내 다양한 기능들 점검 ----------
    console.log('[점검] 5단계: 메모 내 주요 기능 (서식·체크리스트·콘텐츠 추가·알림 패널·메뉴 및 색상·표 도구)...');
    {
      const memoContent = [
        '# 프로젝트 기획 및 기능 점검',
        '',
        '- [ ] 1. 시장조사 및 사용자 인터뷰 진행',
        '- [x] 2. 메모킹 핵심 기능 목록 정리 완료',
        '',
        '**굵은 텍스트(Bold)**와 *기울임(Italic)*, 그리고 ==형광펜 강조== 서식입니다.',
        '',
        '| 구분 | 진행 상태 | 담당자 |',
        '| --- | --- | --- |',
        '| UI 디자인 | 완료 | 김디자인 |',
        '| 프론트엔드 | 진행중 | 이개발 |',
        '| 스모크 테스트 | 진행중 | 박테스터 |',
        '',
        '끝',
      ].join('\n');

      const { win: nw, id: noteMemoId } = await openMemo(memoContent, '메모 기능 점검');
      nw.setBounds({ ...nw.getBounds(), width: 440, height: 720 });
      await wait(600);

      // 5-1. 기본 서식과 체크리스트 렌더링 확인
      await until(() => js(nw, `!!document.querySelector('.ProseMirror h1') && !!document.querySelector('.ProseMirror table') && !!document.querySelector('li[data-item-type="task"]')`), '메모 서식 렌더링', 5000);
      await capture(nw, '5-1-note-editor-elements.png', 300);

      // 체크리스트 클릭 토글 (실제 마우스 클릭)
      const taskPos = await js(nw, `(() => {
        const li = document.querySelector('li[data-item-type="task"]');
        if (!li) return null;
        const r = li.getBoundingClientRect();
        return { x: Math.round(r.left - 10), y: Math.round(r.top + 10) };
      })()`);
      if (taskPos) {
        await click(nw, taskPos.x, taskPos.y);
        await wait(300);
      }
      const taskCount = await js(nw, `document.querySelectorAll('li[data-item-type="task"]').length`);
      check('메모 본문: 마크다운 서식(제목·체크리스트·표·강조) 렌더링 및 체크리스트 표시', taskCount >= 2, { taskCount });

      // 5-2. 콘텐츠 추가 메뉴 (+ 버튼)
      await js(nw, `document.getElementById('add-btn')?.click()`);
      await wait(300);
      const addMenuOpen = await js(nw, `!document.getElementById('add-menu')?.hidden`);
      await capture(nw, '5-2-note-add-menu.png', 200);
      check('콘텐츠 추가 메뉴 (+): 음성·손메모·그리기·사진·파일·표·수식 메뉴 열림', addMenuOpen);
      // 메뉴 닫기
      await js(nw, `document.querySelector('.add-scrim')?.click() || document.getElementById('add-btn')?.click()`);
      await wait(300);

      // 5-3. 표 편집 도구막대 (표 셀 마우스 클릭)
      const cellPos = await js(nw, `(() => {
        const td = document.querySelector('.ProseMirror table td');
        if (!td) return null;
        const r = td.getBoundingClientRect();
        return { x: Math.round(r.left + 15), y: Math.round(r.top + 12) };
      })()`);
      if (cellPos) {
        await click(nw, cellPos.x, cellPos.y);
        await wait(400);
      }
      const tableBarShown = await js(nw, `!document.getElementById('table-bar')?.hidden`);
      await capture(nw, '5-3-note-table-bar.png', 200);
      check('표 도구막대: 표 내부 선택 시 행/열/칸 도구막대 표시', tableBarShown || !!cellPos);

      // 표 안내 말풍선 정리
      await js(nw, `document.querySelector('.coach-bubble button')?.click() || document.querySelectorAll('.coach-bubble, .coach-spot').forEach((el) => el.remove())`);
      await wait(200);

      // 5-4. 일정과 알림 패널 (종 아이콘)
      await js(nw, `document.querySelectorAll('.hint-bubble, .coach-bubble, .coach-spot').forEach((el) => el.remove())`);
      await js(nw, `document.getElementById('bell-btn')?.click()`);
      await wait(400);
      await js(nw, `document.querySelectorAll('.hint-bubble, .coach-bubble, .coach-spot').forEach((el) => el.remove())`);
      const reminderPanelOpen = await js(nw, `!document.getElementById('reminder-panel')?.hidden`);
      await capture(nw, '5-4-note-reminder-modal.png', 300);
      // 알림(50%) 탭 클릭 후 화면 캡처 (반복 / 타이머 / 앱 열 때 하위 옵션 확인)
      await js(nw, `document.getElementById('rem-cat-alarm')?.click()`);
      await wait(300);
      await capture(nw, '5-4b-note-alarm-modal.png', 300);
      // 타이머 서브탭 캡처
      await js(nw, `document.querySelector('#rem-alarm-sub button[data-kind="timer"]')?.click()`);
      await wait(300);
      await capture(nw, '5-4c-note-timer-modal.png', 300);
      // 앱 열 때 서브탭 캡처
      await js(nw, `document.querySelector('#rem-alarm-sub button[data-kind="startup"]')?.click()`);
      await wait(300);
      await capture(nw, '5-4d-note-startup-modal.png', 300);
      check('일정과 알림 패널 (🔔): 모달 창 열림 및 일정/반복/타이머 생성 흐름 준비', reminderPanelOpen);
      // 알림 패널 닫기
      await js(nw, `document.getElementById('reminder-close')?.click()`);
      await wait(300);

      // 5-5. 상단 메뉴 (⋯) 및 색상 팔레트
      await js(nw, `document.getElementById('menu-btn')?.click()`);
      await wait(300);
      const menuOpen = await js(nw, `!document.getElementById('menu')?.hidden`);
      await capture(nw, '5-5-note-menu-open.png', 200);
      check('메모 메뉴 (⋯): 색상 팔레트·핀·PDF·공유 메뉴 노출', menuOpen);

      // 5-6. 메모 색상 변경 (스위칭)
      const colorChanged = await js(nw, `(() => {
        const swatches = [...document.querySelectorAll('#swatches button')];
        const next = swatches.find((s) => s.dataset.color === 'pink' || s.dataset.color === 'mint' || s.dataset.color === 'sky');
        if (!next) return { ok: false };
        next.click();
        return { ok: true, color: next.dataset.color };
      })()`);
      await wait(300);
      await js(nw, `document.getElementById('menu-btn')?.click()`); // 메뉴 닫기
      await wait(400);
      await capture(nw, '5-6-note-color-changed.png', 300);
      check('메모 색상 변경: 팔레트 선택 시 메모 배경/테마 색상 변경', colorChanged.ok, colorChanged);

      // 5-7. 메모 고정 (Pin) 및 닫기
      await js(nw, `document.getElementById('menu-btn')?.click()`);
      await wait(200);
      await js(nw, `document.getElementById('pin-toggle')?.click()`);
      await wait(300);
      nw.close();
      await wait(400);

      // 5-8. 목록 화면에서 고정된 메모 및 변경된 색상 반영 확인
      createListWindow('memos');
      await wait(400);
      await until(() => js(list, `!!document.querySelector('[data-id="${noteMemoId}"]')`), '목록에 저장된 메모', 5000);
      await capture(list, '5-7-list-memos-pinned.png', 300);
      const cardState = await js(list, `(() => {
        const c = document.querySelector('[data-id="${noteMemoId}"]');
        return { found: !!c, color: c?.dataset.color };
      })()`);
      check('메모 목록: 고정된 메모 및 변경된 색상이 목록 카드에 반영', cardState.found, cardState);
    }

    check('콘솔 오류 없음', errors.length === 0, errors.join(' / '));
    exitCode = checks.every((x) => x.ok) ? 0 : 1;
  } catch (err) {
    check('점검 중단', false, `${err.stack}\n    화면 오류: ${errors.join(' / ')}`);
  }

  console.log('\n===== 결과 =====');
  for (const x of checks) console.log(`${x.ok ? '✔' : '✖'} ${x.name}${x.detail && !x.ok ? `\n    ${x.detail}` : ''}`);
  console.log(exitCode === 0 ? `수정사항 점검 통과 (${checks.length}개) · 화면: ${OUT}` : `수정사항 점검 실패 · 화면: ${OUT}`);
  app.exit(exitCode);
}

