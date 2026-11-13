// 일정 탭 › "다른 캘린더" 창 (PC·휴대폰 같음) — Google 캘린더 · 삼성 캘린더 · 네이버 캘린더 함께 보기 (읽기만, 그 캘린더는 바꾸지 않는다)
//   .ics 구독 주소(Google 캘린더 "iCal 형식의 비공개 주소" 등) · 네이버 캘린더(CalDAV, 아이디 · 애플리케이션 비밀번호)
//   · 휴대폰 캘린더(삼성 캘린더 · Google 캘린더, 휴대폰만)
import { icon } from './icons.js';
import { normalizeFeedUrl, icsName, feedLabel, MAX_FEEDS } from './core/calendar-feeds.js';
import { koClock, relativeDay, koMonthDay } from './core/time.js';

const NAVER_CALDAV = 'https://caldav.calendar.naver.com';

/** 받은 때: "방금" · "12분 전" · "오늘 오후 3:20" · "10월 14일" */
function receivedAt(ms, now = Date.now()) {
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const d = new Date(ms);
  const rel = relativeDay(d, new Date(now));
  return rel ? `${rel} ${koClock(d)}` : koMonthDay(d);
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function switchInput(label, checked) {
  const input = el('input', 'switch');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('aria-label', label);
  return input;
}

/**
 * @param {{ calendars: any, notify: (text: string, isError?: boolean) => void, feedTexts: Map<string, { at: number, error?: string }> }} o
 * @returns {Promise<void>} 창을 닫으면
 */
export function openCalendarLinks({ calendars, notify, feedTexts }) {
  return new Promise((resolve) => {
    let feeds = [];
    const dialog = el('dialog', 'dialog cal-links');
    dialog.setAttribute('aria-labelledby', 'cal-links-h');
    const head = el('div', 'dialog-head');
    const h = el('h2', '', '다른 캘린더 함께 보기');
    h.id = 'cal-links-h';
    const close = el('button', 'icon-btn dialog-x');
    close.type = 'button';
    close.setAttribute('aria-label', '닫기');
    close.append(icon('close'));
    close.addEventListener('click', () => dialog.close());
    head.append(h, close);
    const lead = el('p', 'cal-links-lead', 'Google 캘린더, 삼성 캘린더, 네이버 캘린더의 일정을 메모킹 달력에 함께 보여 줘요. 보기만 하고, 그 캘린더는 바꾸지 않아요.');

    // ---------- 함께 보기 ----------
    const list = el('ul', 'feed-list');
    list.setAttribute('aria-label', '함께 보는 캘린더');

    // 휴대폰 캘린더 (안드로이드만): 삼성 캘린더 · Google 캘린더 계정 일정이 모두 여기 있다
    let deviceRow = null;
    if (calendars.device) {
      deviceRow = el('li', 'feed-row feed-device');
      const dot = el('span', 'feed-dot');
      const text = el('span', 'feed-text');
      text.append(el('b', '', '이 휴대폰의 캘린더'), el('small', '', '삼성 캘린더, Google 캘린더 등'));
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

    // 더하기는 드물게 쓰니 접어 둔다 (누르면 칸이 열린다): 'ics' · 'naver'
    let addOpen = '';
    const opener = (text, kind, focus) => {
      const b = el('button', 'link-btn feed-open-add', text);
      b.type = 'button';
      b.addEventListener('click', () => {
        addOpen = kind;
        drawList();
        focus().focus();
      });
      return b;
    };
    const openAdd = opener('＋ iCal 주소로 캘린더 더하기', 'ics', () => url);
    const openNaver = opener('＋ 네이버 캘린더 연결', 'naver', () => naverId);
    function drawList() {
      list.replaceChildren(...(deviceRow ? [deviceRow] : []), ...feeds.map(feedRow));
      const full = feeds.length >= MAX_FEEDS;
      addForm.hidden = full || addOpen !== 'ics';
      help.hidden = full || addOpen !== 'ics';
      naverForm.hidden = full || addOpen !== 'naver';
      naverHelp.hidden = full || addOpen !== 'naver';
      openAdd.hidden = full || Boolean(addOpen);
      openNaver.hidden = full || Boolean(addOpen);
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
      if (feeds.some((f) => f.url === clean && !f.user)) {
        addNote.textContent = '이미 잇고 있는 캘린더예요';
        return;
      }
      if (await addFeed({ url: clean, name: '' }, [url, addBtn])) url.value = '';
      canAdd();
    });

    /** 구독을 더하고 바로 받아 본다 — 받지 못하면 남기지 않는다 (고쳐서 다시 넣게). 더했으면 true */
    async function addFeed(entry, inputs) {
      for (const i of inputs) i.disabled = true;
      addNote.classList.remove('err');
      addNote.textContent = '캘린더를 받는 중이에요';
      addNote.classList.add('searching');
      try {
        const before = new Set(feeds.map((f) => f.id));
        feeds = await calendars.setFeeds([...feeds, entry]);
        const added = feeds.find((f) => !before.has(f.id));
        const got = added ? await calendars.fetch(added.id, true) : { error: '추가하지 못했어요' };
        if (!got.text) {
          feeds = await calendars.setFeeds(feeds.filter((f) => f.id !== added?.id));
          addNote.textContent = got.error || '캘린더를 받지 못했어요';
          addNote.classList.add('err');
          return false;
        }
        const name = icsName(got.text);
        if (name) feeds = await calendars.setFeeds(feeds.map((f) => (f.id === added.id ? { ...f, name } : f)));
        feedTexts.set(added.id, got);
        addNote.textContent = `"${name || added.name}" 일정을 함께 보여요`;
        drawList();
        return true;
      } catch (err) {
        addNote.textContent = err.message || '추가하지 못했어요';
        addNote.classList.add('err');
        return false;
      } finally {
        for (const i of inputs) i.disabled = false;
        addNote.classList.remove('searching');
      }
    }

    // 네이버 캘린더: .ics 주소가 없어 CalDAV 로 연다 (아이디 + 애플리케이션 비밀번호, 이 기기에만 저장)
    const naverForm = el('form', 'feed-add feed-naver');
    const naverId = el('input', 'feed-url');
    naverId.placeholder = '네이버 아이디';
    naverId.setAttribute('aria-label', '네이버 아이디');
    naverId.autocomplete = 'username';
    naverId.spellcheck = false;
    const naverPw = el('input', 'feed-url');
    naverPw.type = 'password';
    naverPw.placeholder = '애플리케이션 비밀번호';
    naverPw.setAttribute('aria-label', '네이버 애플리케이션 비밀번호');
    naverPw.autocomplete = 'off';
    const naverBtn = el('button', 'btn', '연결');
    naverBtn.type = 'submit';
    naverForm.append(naverId, naverPw, naverBtn);
    naverForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const user = naverId.value.trim().replace(/@naver\.com$/i, '');
      if (!user) return naverId.focus();
      if (!naverPw.value) return naverPw.focus();
      if (feeds.some((f) => f.url === NAVER_CALDAV && f.user === user)) {
        addNote.textContent = '이미 잇고 있는 캘린더예요';
        return;
      }
      if (await addFeed({ url: NAVER_CALDAV, user, pass: naverPw.value, name: `네이버 캘린더 (${user})` }, [naverId, naverPw, naverBtn])) {
        naverId.value = '';
        naverPw.value = '';
      }
    });
    const naverHelp = el('details', 'cal-help');
    naverHelp.append(el('summary', '', '애플리케이션 비밀번호는 어디서 만드나요?'));
    const naverSteps = el('ol');
    for (const s of [
      '네이버에 로그인하고 "내정보 › 보안설정" 에서 2단계 인증을 켜기',
      '같은 곳의 "애플리케이션 비밀번호 관리" 에서 종류를 "직접 입력"(예: 메모킹)으로 비밀번호 만들기',
      '만든 비밀번호를 위에 붙여 넣기 (네이버 로그인 비밀번호가 아니에요)',
    ]) naverSteps.append(el('li', '', s));
    naverHelp.append(naverSteps, el('p', '', calendars.device
      ? '네이버의 모든 캘린더를 읽기만 하고, 아이디와 비밀번호는 이 휴대폰에만 저장해요.'
      : '네이버의 모든 캘린더를 읽기만 하고, 아이디와 비밀번호는 이 PC에만 저장해요.'));

    const help = el('details', 'cal-help');
    help.append(el('summary', '', 'Google 캘린더, 삼성 캘린더 주소는 어디서 찾나요?'));
    const steps = el('ol');
    for (const s of [
      'PC 브라우저에서 Google 캘린더(calendar.google.com)를 열고 오른쪽 위 톱니의 설정',
      '왼쪽 "내 캘린더의 설정"에서 볼 캘린더를 고르기',
      '"캘린더 통합" 의 "iCal 형식의 비공개 주소" 를 복사해 위에 붙여 넣기',
    ]) steps.append(el('li', '', s));
    help.append(steps, el('p', '', calendars.device
      ? '삼성 캘린더는 위의 "이 휴대폰의 캘린더" 를 켜면 바로 보여요. 비공개 주소는 그 캘린더를 누구나 볼 수 있는 열쇠라 이 기기에만 저장해요.'
      : '삼성 캘린더: Galaxy 휴대폰의 삼성 캘린더를 Google 계정과 동기화해 두면, 그 Google 캘린더 주소로 PC에서도 보여요. 휴대폰 메모킹에서는 "이 휴대폰의 캘린더" 를 켜면 바로 보여요. 비공개 주소는 그 캘린더를 누구나 볼 수 있는 열쇠라 이 PC에만 저장해요.'));

    const actions = el('div', 'dialog-actions');
    const done = el('button', 'btn', '닫기');
    done.type = 'button';
    done.addEventListener('click', () => dialog.close());
    actions.append(done);

    dialog.append(head, lead, list, openAdd, openNaver, addForm, naverForm, addNote, help, naverHelp, actions);
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve();
    });
    document.body.append(dialog);
    // 저장된 구독을 읽기 전에는 넣지 못하게 (빈 목록에 더해 저장하면 있던 구독이 사라진다)
    addBtn.disabled = true;
    url.disabled = true;
    naverBtn.disabled = true;
    calendars.feeds().then((list0) => {
      feeds = list0;
      url.disabled = false;
      naverBtn.disabled = false;
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
