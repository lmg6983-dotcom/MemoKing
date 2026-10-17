// 일정 탭 › "다른 캘린더" 창 (PC·휴대폰 같음) — Google 캘린더 · 삼성 캘린더와 잇기
//   함께 보기: .ics 구독 주소(Google 캘린더 "iCal 형식의 비공개 주소" 등) · 휴대폰 캘린더(삼성 캘린더 · Google 캘린더, 휴대폰만)
//   보내기: 메모킹 일정을 .ics 파일로 (각 캘린더의 "가져오기") — 하나만은 일정 줄의 보내기 단추
import { icon } from './icons.js';
import { normalizeFeedUrl, icsName, feedLabel, buildIcs, MAX_FEEDS } from './core/calendar-feeds.js';
import { isEvent } from './core/reminders.js';
import { koClock, relativeDay, koMonthDay } from './core/time.js';

/** 맞춘 때: "방금 맞췄어요" · "12분 전에 맞췄어요" · "오늘 오후 3:20에 맞췄어요" */
function syncedAt(ms) {
  const t = receivedAt(ms);
  return t === '방금' ? '방금 맞췄어요' : `${t}에 맞췄어요`;
}

/** 받은 때: "방금" · "12분 전" · "오늘 오후 3:20" · "10월 14일" */
function receivedAt(ms, now = Date.now()) {
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const d = new Date(ms);
  const rel = relativeDay(d, new Date(now));
  return rel ? `${rel} ${koClock(d)}` : koMonthDay(d);
}

const GOOGLE_IMPORT = 'https://calendar.google.com/calendar/r/settings/export';

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** 칸 제목 + 메모킹이 그 캘린더에 무엇을 하는지(읽기 · 쓰기) 꼬리표 + 한 줄 설명 */
function section(title, badge, kind, caption) {
  const wrap = el('div', 'cal-sec');
  const h = el('h3', 'cal-links-h3', title);
  h.append(el('span', `cal-perm cal-perm-${kind}`, badge));
  wrap.append(h, el('p', 'cal-sec-cap', caption));
  return wrap;
}

function switchInput(label, checked) {
  const input = el('input', 'switch');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('aria-label', label);
  return input;
}

/**
 * @param {{ calendars: any, items: any[], notify: (text: string, isError?: boolean) => void, feedTexts: Map<string, { at: number, error?: string }> }} o
 * @returns {Promise<void>} 창을 닫으면
 */
export function openCalendarLinks({ calendars, items, notify, feedTexts }) {
  return new Promise((resolve) => {
    let feeds = [];
    const dialog = el('dialog', 'dialog cal-links');
    dialog.setAttribute('aria-labelledby', 'cal-links-h');
    const head = el('div', 'dialog-head');
    const h = el('h2', '', '다른 캘린더와 잇기');
    h.id = 'cal-links-h';
    const close = el('button', 'icon-btn dialog-x');
    close.type = 'button';
    close.setAttribute('aria-label', '닫기');
    close.append(icon('close'));
    close.addEventListener('click', () => dialog.close());
    head.append(h, close);
    const lead = el('p', 'cal-links-lead', '메모킹이 다른 캘린더에 쓰는지, 읽기만 하는지에 따라 나눴어요.');

    const twice = el('p', 'feed-note cal-twice', '주고받기의 "메모킹" 캘린더는 여기서 빼고 보여요 (같은 일정이 두 번 보이지 않게)');
    twice.hidden = true;
    // ---------- Google 캘린더와 서로 맞추기 ----------
    const google = calendars.google;
    const syncTitle = section('Google 캘린더와 주고받기', '읽기 + 쓰기', 'rw', '메모킹 일정 ⇄ Google 캘린더의 "메모킹" 캘린더. 어느 쪽에서 고치거나 만들어도 서로 들어가요');
    const syncCard = el('div', 'gsync');
    const syncText = el('span', 'feed-text');
    const syncName = el('b');
    const syncSub = el('small');
    syncText.append(syncName, syncSub);
    const syncDot = el('span', 'gsync-dot');
    const syncBtns = el('div', 'gsync-btns');
    const connectBtn = el('button', 'btn primary', '연결하기');
    connectBtn.type = 'button';
    const nowBtn = el('button', 'btn', '지금 맞추기');
    nowBtn.type = 'button';
    const offBtn = el('button', 'link-btn gsync-off', '연결 끊기');
    offBtn.type = 'button';
    syncBtns.append(connectBtn, nowBtn, offBtn);
    syncCard.append(syncDot, syncText, syncBtns);
    const syncHelp = el('details', 'cal-help');
    syncHelp.append(el('summary', '', '어떻게 맞추나요?'));
    const syncSteps = el('ul');
    for (const t of [
      'Google 계정에 "메모킹" 캘린더를 만들고, 메모킹 일정(날짜 · 반복 일정)을 거기에 넣어요. 타이머 · 앱 열 때 알림은 넣지 않아요',
      'Google 캘린더나 삼성 캘린더에서 그 캘린더의 일정을 고치거나 지우면 메모에도 그대로 들어와요. 거기서 새로 만든 일정은 새 메모가 돼요',
      '삼성 캘린더: 휴대폰 설정 › 계정에 Google 계정이 있으면 삼성 캘린더에 "메모킹" 캘린더가 보여요 (캘린더 › 관리에서 켜기)',
      '양쪽에서 같은 일정을 고치면 나중에 고친 쪽을 따라요. 알림은 메모킹이 울려요 (Google 쪽 알림은 꺼 둬요)',
      'PC 와 휴대폰이 둘 다 켜져 있으면 한쪽만 맞추고, 꺼져 있으면 다른 쪽이 이어받아요',
      '권한은 "메모킹이 만든 캘린더만" — 다른 캘린더의 일정은 보지 않아요',
    ]) syncSteps.append(el('li', '', t));
    syncHelp.append(syncSteps);

    let busy = false;
    function drawSync(info) {
      const on = Boolean(info?.connected);
      twice.hidden = !on || !calendars.device;
      syncCard.classList.toggle('on', on);
      syncCard.classList.toggle('error', on && Boolean(info?.error));
      connectBtn.hidden = on;
      nowBtn.hidden = !on;
      offBtn.hidden = !on;
      nowBtn.disabled = busy || Boolean(info?.running);
      connectBtn.disabled = busy;
      if (!on) {
        syncName.textContent = '연결 안 됨';
        syncSub.textContent = 'Google 계정으로 연결하면 삼성 캘린더에서도 보이고 고칠 수 있어요';
        return;
      }
      syncName.textContent = 'Google 캘린더의 "메모킹" 캘린더와 맞춰요';
      syncSub.classList.toggle('err', Boolean(info.error));
      if (info.running) syncSub.textContent = '맞추는 중이에요…';
      else if (info.error) syncSub.textContent = info.error;
      else if (info.holder) syncSub.textContent = `${info.holder.startsWith('pc') ? 'PC' : '휴대폰'} 메모킹이 맞추고 있어요${info.lastSync ? `, 마지막 ${receivedAt(info.lastSync)}` : ''}`;
      else if (info.lastSync) {
        const l = info.last;
        const did = l && (l.pushed || l.pulled || l.imported || l.removed)
          ? ` (보냄 ${l.pushed} · 받음 ${l.pulled + l.imported} · 지움 ${l.removed})` : '';
        syncSub.textContent = `${syncedAt(info.lastSync)}${did}${l?.notes?.length ? `\n${l.notes.join('\n')}` : ''}`;
      } else syncSub.textContent = '곧 맞춰요';
    }
    let unsubscribe = null;
    if (google) {
      google.status().then(drawSync).catch(() => drawSync(null));
      unsubscribe = google.onStatus?.(drawSync) ?? null;
      const act = async (fn, failText) => {
        busy = true;
        drawSync({ connected: syncCard.classList.contains('on'), running: true });
        try {
          drawSync(await fn());
        } catch (err) {
          const msg = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^\w*Error:\s*/, '');
          if (!/취소/.test(msg)) notify(`${failText}\n${msg}`, true);
          drawSync(await google.status().catch(() => null));
        } finally {
          busy = false;
          drawSync(await google.status().catch(() => null));
        }
      };
      connectBtn.addEventListener('click', () => act(() => google.connect(), 'Google 캘린더와 연결하지 못했어요'));
      nowBtn.addEventListener('click', () => act(() => google.sync(), 'Google 캘린더와 맞추지 못했어요'));
      offBtn.addEventListener('click', () => act(async () => {
        const out = await google.disconnect();
        notify('연결을 끊었어요. Google 캘린더의 "메모킹" 캘린더와 메모의 일정은 그대로 있어요');
        return out;
      }, '연결을 끊지 못했어요'));
    }

    // ---------- 함께 보기 ----------
    const seeTitle = section('함께 보기', '읽기만', 'r', '그 캘린더의 일정을 메모킹 달력에 보여 주기만 해요. 그 캘린더는 바꾸지 않아요');
    const list = el('ul', 'feed-list');
    list.setAttribute('aria-label', '함께 보는 캘린더');

    // 휴대폰 캘린더 (안드로이드만): 삼성 캘린더 · Google 캘린더 계정 일정이 모두 여기 있다
    let deviceRow = null;
    if (calendars.device) {
      deviceRow = el('li', 'feed-row feed-device');
      const dot = el('span', 'feed-dot');
      const text = el('span', 'feed-text');
      text.append(el('b', '', '이 휴대폰의 캘린더'), el('small', '', '삼성 캘린더 · Google 캘린더 등'));
      const sw = switchInput('이 휴대폰의 캘린더 함께 보기', calendars.device.enabled());
      sw.addEventListener('change', async () => {
        const want = sw.checked;
        sw.disabled = true;
        const on = await calendars.device.setEnabled(want).catch(() => false);
        sw.checked = on;
        sw.disabled = false;
        if (want && !on) notify('캘린더 권한을 허용해야 휴대폰 일정을 볼 수 있어요', true);
      });
      deviceRow.append(dot, text, sw);
    }

    function feedRow(f) {
      const li = el('li', 'feed-row');
      li.style.setProperty('--ext-color', f.color);
      const dot = el('span', 'feed-dot');
      const text = el('span', 'feed-text');
      const got = feedTexts.get(f.id);
      const sub = got?.error ? got.error : got?.at ? `${feedLabel(f.url)}, ${receivedAt(got.at)} 받음` : feedLabel(f.url);
      const small = el('small', got?.error ? 'err' : '', sub);
      text.append(el('b', '', f.name), small);
      const sw = switchInput(`${f.name} 함께 보기`, f.on);
      sw.addEventListener('change', async () => {
        try {
          feeds = await calendars.setFeeds(feeds.map((x) => (x.id === f.id ? { ...x, on: sw.checked } : x)));
        } catch (err) {
          sw.checked = !sw.checked; // 저장하지 못했으면 되돌린다
          notify(err.message || '저장하지 못했어요', true);
        }
      });
      const del = el('button', 'icon-btn');
      del.type = 'button';
      del.title = '연결 끊기';
      del.setAttribute('aria-label', `${f.name} 연결 끊기`);
      del.append(icon('trash'));
      del.addEventListener('click', async () => {
        try {
          feeds = await calendars.setFeeds(feeds.filter((x) => x.id !== f.id));
        } catch (err) {
          notify(err.message || '연결을 끊지 못했어요', true);
          return;
        }
        feedTexts.delete(f.id);
        drawList();
      });
      li.append(dot, text, sw, del);
      return li;
    }

    // 주소로 더하기는 드물게 쓰니 접어 둔다 (누르면 칸이 열린다)
    let addOpen = false;
    const openAdd = el('button', 'link-btn feed-open-add', '＋ iCal 주소로 캘린더 더하기');
    openAdd.type = 'button';
    openAdd.addEventListener('click', () => {
      addOpen = true;
      drawList();
      url.focus();
    });
    function drawList() {
      list.replaceChildren(...(deviceRow ? [deviceRow] : []), ...feeds.map(feedRow));
      const full = feeds.length >= MAX_FEEDS;
      addForm.hidden = full || !addOpen;
      help.hidden = full || !addOpen;
      openAdd.hidden = full || addOpen;
    }

    // 주소 넣기
    const addForm = el('form', 'feed-add');
    const url = el('input', 'feed-url');
    url.type = 'url';
    url.placeholder = 'iCal 주소 붙여 넣기';
    url.setAttribute('aria-label', '캘린더 iCal 주소');
    url.autocomplete = 'off';
    url.spellcheck = false;
    const addNote = el('p', 'feed-note');
    addNote.setAttribute('role', 'status');
    const addBtn = el('button', 'btn', '추가'); // 눈에 띄는 노랑은 "연결하기" 한 곳만
    addBtn.type = 'submit';
    const canAdd = () => {
      addBtn.disabled = url.disabled || !url.value.trim();
    };
    url.addEventListener('input', () => {
      canAdd();
      if (addNote.classList.contains('err')) {
        addNote.textContent = '';
        addNote.classList.remove('err');
      }
    });
    addForm.append(url, addBtn);
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!url.value.trim()) return url.focus(); // 빈 칸: 꾸짖지 않고 칸으로
      const clean = normalizeFeedUrl(url.value);
      addNote.classList.remove('err');
      if (!clean) {
        addNote.textContent = 'https:// 나 webcal:// 로 시작하는 캘린더 주소를 넣어 주세요';
        addNote.classList.add('err');
        return;
      }
      if (feeds.some((f) => f.url === clean)) {
        addNote.textContent = '이미 잇고 있는 캘린더예요';
        return;
      }
      addBtn.disabled = true;
      url.disabled = true;
      addNote.textContent = '캘린더를 받는 중이에요…';
      addNote.classList.add('searching');
      try {
        const before = new Set(feeds.map((f) => f.id));
        feeds = await calendars.setFeeds([...feeds, { url: clean, name: '' }]);
        const added = feeds.find((f) => !before.has(f.id));
        const got = added ? await calendars.fetch(added.id, true) : { error: '추가하지 못했어요' };
        if (!got.text) {
          // 받지 못한 주소는 남기지 않는다 (고쳐서 다시 넣게)
          feeds = await calendars.setFeeds(feeds.filter((f) => f.id !== added?.id));
          addNote.textContent = got.error || '캘린더를 받지 못했어요';
          addNote.classList.add('err');
          return;
        }
        const name = icsName(got.text);
        if (name) feeds = await calendars.setFeeds(feeds.map((f) => (f.id === added.id ? { ...f, name } : f)));
        feedTexts.set(added.id, got);
        url.value = '';
        addNote.textContent = `"${name || added.name}" 일정을 함께 보여요`;
        drawList();
      } catch (err) {
        addNote.textContent = err.message || '추가하지 못했어요';
        addNote.classList.add('err');
      } finally {
        url.disabled = false;
        canAdd();
        addNote.classList.remove('searching');
      }
    });

    const help = el('details', 'cal-help');
    help.append(el('summary', '', 'Google 캘린더 · 삼성 캘린더 주소는 어디서 찾나요?'));
    const steps = el('ol');
    for (const s of [
      'PC 브라우저에서 Google 캘린더(calendar.google.com)를 열고 오른쪽 위 톱니 › 설정',
      '왼쪽 "내 캘린더의 설정"에서 볼 캘린더를 고르기',
      '"캘린더 통합" 의 "iCal 형식의 비공개 주소" 를 복사해 위에 붙여 넣기',
    ]) steps.append(el('li', '', s));
    help.append(steps, el('p', '', calendars.device
      ? '삼성 캘린더는 위의 "이 휴대폰의 캘린더" 를 켜면 바로 보여요. 비공개 주소는 그 캘린더를 누구나 볼 수 있는 열쇠라 이 기기에만 저장해요.'
      : '삼성 캘린더: Galaxy 휴대폰의 삼성 캘린더를 Google 계정과 동기화해 두면, 그 Google 캘린더 주소로 PC 에서도 보여요. 휴대폰 메모킹에서는 "이 휴대폰의 캘린더" 를 켜면 바로 보여요. 비공개 주소는 그 캘린더를 누구나 볼 수 있는 열쇠라 이 PC 에만 저장해요.'));

    // ---------- 보내기 ----------
    // 한 번만 넣는 방법이라(서로 맞추기가 있으니) 접어 둔다
    const sendTitle = section('보내기', '쓰기만', 'w', '메모킹 일정을 다른 캘린더에 한 번 넣어요. 그 뒤에 바뀐 건 따라가지 않아요');
    const send = el('details', 'cal-help cal-send');
    send.append(el('summary', '', '파일로 한 번에 보내기 (.ics)'));
    const events = items.filter((i) => isEvent(i.reminder));
    const exportBtn = el('button', 'cal-export');
    exportBtn.type = 'button';
    exportBtn.append(icon('cal-out'));
    const exportText = el('span', 'feed-text');
    exportText.append(el('b', '', `메모킹 일정 ${events.length}개를 캘린더 파일(.ics)로`), el('small', '', '삼성 캘린더 · Google 캘린더 · Outlook 의 "가져오기" 로 한 번에 넣어요'));
    exportBtn.append(exportText);
    exportBtn.disabled = !events.length;
    exportBtn.addEventListener('click', async () => {
      try {
        const res = await calendars.exportIcs(buildIcs(events), '메모킹 일정.ics');
        if (res?.error) notify(res.error, true);
        else if (!res?.cancelled && !calendars.device) notify('캘린더 파일을 저장했어요. Google 캘린더 › 설정 › 가져오기에서 넣어 주세요');
      } catch (err) {
        notify(err.message || '내보내지 못했어요', true);
      }
    });
    const sendNote = el('p', 'feed-note');
    sendNote.append('일정 하나만 보내려면 일정 줄의 ', icon('cal-out'), calendars.device ? ' 단추 (삼성 캘린더 등 캘린더 앱의 새 일정 화면이 열려요)' : ' 단추 (Google 캘린더의 새 일정 화면이 열려요)');
    const importLink = el('button', 'link-btn cal-google-import', 'Google 캘린더 가져오기 화면 열기');
    importLink.type = 'button';
    importLink.addEventListener('click', () => calendars.openUrl?.(GOOGLE_IMPORT));

    const actions = el('div', 'dialog-actions');
    const done = el('button', 'btn', '닫기');
    done.type = 'button';
    done.addEventListener('click', () => dialog.close());
    actions.append(done);

    send.append(exportBtn, sendNote, ...(calendars.openUrl ? [importLink] : []));
    dialog.append(head, lead, ...(google ? [syncTitle, syncCard, syncHelp] : []), seeTitle, list, twice, openAdd, addForm, addNote, help, sendTitle, send, actions);
    dialog.addEventListener('close', () => {
      unsubscribe?.();
      dialog.remove();
      resolve();
    });
    document.body.append(dialog);
    // 저장된 구독을 읽기 전에는 넣지 못하게 (빈 목록에 더해 저장하면 있던 구독이 사라진다)
    addBtn.disabled = true;
    url.disabled = true;
    calendars.feeds().then((list0) => {
      feeds = list0;
      url.disabled = false;
      canAdd();
      drawList();
    }).catch((err) => {
      addNote.textContent = `캘린더 목록을 읽지 못했어요. 창을 닫았다 다시 열어 주세요 (${err?.message ?? err})`;
      addNote.classList.add('err');
    });
    drawList();
    dialog.showModal();
  });
}
