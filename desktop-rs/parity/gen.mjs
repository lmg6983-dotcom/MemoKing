// JS 규칙(app/js/core)과 Rust core 가 같은 답을 내는지 — JS 의 답을 fixtures 로 남긴다.
//   node desktop-rs/parity/gen.mjs   → desktop-rs/core/tests/fixtures/*.json (커밋해 둔다)
//   CI 가 다시 만들어 바뀌었으면(= JS 규칙이 바뀌었는데 Rust 는 그대로) 실패한다. 시간대는 TZ=Asia/Seoul 로 고정해 돌린다.
import fs from 'node:fs';
import path from 'node:path';
import { stringify } from '../../app/vendor/yaml.js';
import * as mf from '../../app/js/core/memo-file.js';
import { extractTags } from '../../app/js/core/tags.js';
import { taskProgress } from '../../app/js/core/tasks.js';
import { isLockedBody, lockBody, lockRefKey } from '../../app/js/core/memo-lock.js';
import { cleanFolderName } from '../../app/js/core/folders.js';
import { textMatcher } from '../../app/js/core/text-match.js';
import { isProgramFile } from '../../app/js/core/file-kinds.js';
import { shareText } from '../../app/js/core/share-text.js';
import { normalizeReminder, nextOccurrence, nextAlert, dueOccurrence, dueAtStartup, markFired, isLiveCached, nextTime, isPastEvent, alertsOf, alertTime, alarmText, describeReminder } from '../../app/js/core/reminders.js';
import { normalizeFeeds } from '../../app/js/core/calendar-feed-list.js';
import { hotkeyCopyText, normalizeHotkeys, assignHotkey } from '../../app/js/core/memo-hotkeys.js';
import { isValidAccelerator, displayAccelerator, normalizeShortcuts, withShortcuts } from '../../app/js/core/accelerators.js';
import { comboFromAccelerator } from '../../app/js/core/keymap.js';
import { TUTORIAL_STEPS, TUTORIAL_EVENTS, tutorialStepFor, tutorialChapter, tutorialJumps, advanceTutorial } from '../../app/js/core/tutorial.js';
import { indexOutput, tokenize, AGENT_GUIDE } from '../../app/js/core/indexer.js';
import { NOUNS } from '../../app/js/core/korean-nouns.js';
import { parseLinkPreview, detectCharset, hostOf, youtubeOEmbedUrl, parseYoutubeOEmbed, staleYoutubeEntry } from '../../app/js/core/link-preview.js';
import { imageExtFromType, imageExtFromUrl } from '../../app/js/core/remote-images.js';
import { versionTitles } from '../../app/js/core/release-notes.js';
import { suggestTagsFor, matchExisting, appendTags, removeTags } from '../../app/js/core/tag-suggest.js';
import { autoTagsFor } from '../../app/js/core/auto-tags.js';
import { noThink, sseText, engineError, chatBody } from '../../app/js/core/llama-client.js';
import { spellMessages, styleMessages, draftMessages, cleanWriteOutput, plausibleFix } from '../../app/js/core/ai-write.js';
import { aiTagRequest, aiTagResult } from '../../app/js/core/ai-tags.js';
import { chunkMemo, askedPeriod, buildIndex as ragBuildIndex, retrieve as ragRetrieve, expandMessages, expandResult, ragMessages, finishAnswer } from '../../app/js/core/rag.js';
import { StackStore } from '../../desktop/stacks.js';
import { dropBounds, isInside } from '../../desktop/placement.js';
import { placeBubble } from '../../desktop/bubble-place.js';
import { corpus, yamlStrings, indexSets } from './corpus.mjs';
import { driveCases } from './drive.mjs';

const out = path.join(import.meta.dirname, '..', 'core', 'tests', 'fixtures');
fs.mkdirSync(out, { recursive: true });
const write = (name, cases) => {
  fs.writeFileSync(path.join(out, `${name}.json`), `${JSON.stringify(cases, null, 1)}\n`);
  console.log(`${name}: ${cases.length}`);
};
// 던지면 { error } — Rust 도 실패해야 한다
const run = (fn) => {
  try {
    return fn();
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
};

// YAML 한 값 → 머리말에 쓰는 글자 (yaml npm 의 따옴표 · 블록 규칙)
write('yaml_stringify', yamlStrings().map((value) => ({ value, yaml: stringify({ k: value }, { lineWidth: 0 }) })));

// 메모 파일 읽기 → { meta, body }, 그 meta 로 다시 쓰기
write('memo_file', corpus().map((text) => {
  const parsed = run(() => mf.parseMemoFile(text));
  return { text, parsed, serialized: parsed.error ? null : run(() => mf.serializeMemoFile(parsed.meta, parsed.body)) };
}));

// 본문 → 목록 카드에 쓰는 것들
write('memo_body', corpus().map((text) => {
  const { body } = mf.parseMemoFile(text);
  return {
    body,
    plainLines: mf.plainLines(body),
    title: mf.extractTitle(body),
    preview: mf.extractPreview(body, 1200),
    media: mf.extractMedia(body),
    blank: mf.isBlankBody(body),
    tags: extractTags(body),
    tasks: taskProgress(body),
    locked: isLockedBody(body),
  };
}));

// 파일 이름 · 폴더 이름 · 다른 기기 충돌 사본 (제목 줄 · 본문마다)
const names = [...new Set(corpus().flatMap((t) => [mf.extractTitle(mf.parseMemoFile(t).body), ...t.split('\n').slice(0, 3)]))]
  .concat(['con', 'CON.txt', 'nul .md', 'com1', 'lpt9 x', '~$문서', '  ...점점  ', '<>:"/\\|?*#^[]', 'a'.repeat(70), '_memoking', 'Attachments', '.숨김', '업무', '업무 ', '업무.', '가'.repeat(50)]);
write('names', names.map((s) => ({ s, file: mf.titleToFileName(s), folder: cleanFolderName(s) })));
write('conflict_copy', corpus().map((t) => mf.parseMemoFile(t).body).map((body) => ({ body, copy: mf.conflictCopyBody(body, '다른 기기 10월 5일 08:34') })));

// 찾기: 검색어 × 글 → 맞나 (초성 · 기호 빼고 · 여러 낱말)
const texts = ['장보기 목록', '회의록 2026', 'P2026-1170-KR01 견적', 'FPD/202608-0118/E', 'Hello World', '회 의 록', 'ㅎㅇㄹ 그대로', 'C# 언어 메모', '가나다'];
const queries = ['', '장보기', 'ㅈㅂㄱ', 'ㅎㅇㄹ', 'hello world', 'HELLO', 'p20261170kr01', 'FPD2026080118E', '2026', '회의 2026', 'ㄱㅈ', 'c#', '없는말', 'ㄱㄴㄷ', 'kr01 견적', '0118'];
write('search', queries.flatMap((q) => texts.map((t) => ({ q, t, hit: textMatcher(q)(t) }))));

// 잠금: JS 가 잠근 글을 Rust 가 같은 비밀번호로 푼다 (암호문은 돌릴 때마다 달라 한 번 만든 것을 둔다 — 있으면 다시 만들지 않음)
const lockFile = path.join(out, 'lock.json');
if (!fs.existsSync(lockFile)) {
  const plains = ['# 비밀 메모\n\n![사진](attachments/a.png) 계좌 123', '제목 없는 글', '😀 이모지 · 한글 NFC 정규화 비밀번호', ''];
  const cases = [];
  for (const [i, plain] of plains.entries()) {
    const password = ['비밀번호', 'pass word', '한글\u1100\u1161', '1234'][i];
    cases.push({ password, plain, locked: await lockBody(plain, password, { iterations: 1000, hideTitle: i === 1 }) });
  }
  write('lock', cases);
}
write('lock_ref', ['attachments/a.png', 'attachments/한글 사진.jpg'].map((src) => ({ src, salt: 'c2FsdHNhbHQ=', key: lockRefKey(src, 'c2FsdHNhbHQ=') })));

// 열기 전에 물을 프로그램 파일
const fileNames = ['a.exe', 'A.EXE', 'setup.msi', 'x.lnk', 'run.ps1', 'doc.pdf', 'photo.png', 'noext', '.exe', 'archive.tar.gz', 'dir/evil.bat', 'dir\\evil.CMD', 'q.url?x', 'page.html#a.exe', 'x.settingcontent-ms', 'x.appref-ms', 'x.js', 'x.json'];
write('program_files', fileNames.map((name) => ({ name, program: isProgramFile(name) })));

// 알림이 울릴 때: 종류마다의 알림 × 정해 둔 "지금" (진짜 시계는 쓰지 않는다). 시각은 ms 숫자로
const C = '2026-11-10T10:00:00+09:00';
const rawReminders = [
  { kind: 'timer', at: '2026-11-17T09:05:00+09:00', minutes: 10 },
  { kind: 'timer', at: '2026-11-17T09:05:00+09:00', minutes: 10, last: '2026-11-17T09:05:01+09:00' },
  { kind: 'at', at: '2026-11-17T09:00:00+09:00' },
  { kind: 'at', at: '2026-11-17T09:00:00+09:00', end: '2026-11-17T10:00:00+09:00', alerts: [10, 1440] },
  { kind: 'at', at: '2026-11-17T09:00:00+09:00', end: '2026-11-17T10:00:00+09:00', alerts: [0], last: '2026-11-16T09:00:00+09:00' },
  { kind: 'at', at: '2026-11-17T09:00:00+09:00', alerts: [1440], created: '2026-11-16T20:00:00+09:00' },
  { kind: 'at', at: '2026-11-17T09:00:00+09:00', alerts: [] },
  { kind: 'at', at: '2026-11-18T00:00:00+09:00', end: '2026-11-20T00:00:00+09:00', allDay: true, alerts: [-540, 900] },
  { kind: 'at', at: '2026-11-17T00:00:00+09:00', allDay: true },
  { kind: 'repeat', repeat: { every: 'day', time: '09:00' }, alerts: [0, 1440] },
  { kind: 'repeat', repeat: { every: 'day', time: '7:5' }, last: '2026-11-16T07:05:00+09:00' },
  { kind: 'repeat', repeat: { every: 'week', weekdays: [1, 3], time: '09:00' } },
  { kind: 'repeat', repeat: { every: 'week', weekdays: [5], time: '09:00', interval: 2, from: '2026-11-13' }, alerts: [30] },
  { kind: 'repeat', repeat: { every: 'week', weekdays: [0, 6], time: '23:30', interval: 3 } },
  { kind: 'repeat', repeat: { every: 'month', day: 31, time: '18:30' } },
  { kind: 'repeat', repeat: { every: 'month', day: 29 }, allDay: true, alerts: [-540, 1440] },
  { kind: 'repeat', repeat: { every: 'year', month: 2, day: 29, time: '07:00' } },
  { kind: 'repeat', repeat: { every: 'year', month: 12, day: 31, time: '00:00' }, alerts: [10080] },
  { kind: 'at', task: true, at: '2026-11-17T09:00:00+09:00' },
  { kind: 'at', task: true, done: true, at: '2026-11-17T09:00:00+09:00', last: '2026-11-17T09:00:05+09:00' },
  { kind: 'repeat', task: true, repeat: { every: 'week', weekdays: [2], time: '18:00' } },
  { kind: 'at', at: '2026-11-17T09:00:00+09:00', alerts: [10], enabled: false },
  { kind: 'repeat', repeat: { every: 'day', time: '09:00' }, enabled: false },
  { kind: 'startup', startup: 'every' },
  { kind: 'startup', startup: 'daily' },
  { kind: 'startup', startup: 'daily', last: '2026-11-17T08:00:00+09:00' },
  { kind: 'startup', startup: 'once' },
  { kind: 'timer', at: '2026-11-17T09:05:00+09:00', minutes: 120, title: '라면' },
  { kind: 'at', at: '2026-11-17T09:30:00+09:00', end: '2026-11-18T10:00:00+09:00', alerts: [30, 90], title: '치과' },
  { kind: 'repeat', repeat: { every: 'week', weekdays: [0, 1, 2, 3, 4, 5, 6], time: '09:00' } },
];
const reminders = rawReminders.map((raw, i) => normalizeReminder({ id: `r${i}`, action: 'notify', created: C, ...raw }));
const nows = ['2025-06-01T00:00:00+09:00', '2026-11-16T08:50:00+09:00', '2026-11-17T08:49:00+09:00', '2026-11-17T08:59:00+09:00', '2026-11-17T09:00:30+09:00',
  '2026-11-17T09:10:00+09:00', '2026-11-17T23:40:00+09:00', '2026-11-30T23:59:59+09:00', '2026-12-31T23:59:00+09:00', '2027-01-31T10:00:00+09:00',
  '2027-02-27T12:00:00+09:00', '2028-02-28T21:00:00+09:00'];
const ms = (d) => (d ? d.getTime() : null);
const alertJson = (a) => (a ? { at: ms(a.at), start: ms(a.start), offset: a.offset, also: a.also.map((o) => ({ start: ms(o.start), offset: o.offset })), ...('missed' in a ? { missed: a.missed } : {}) } : null);
write('reminders', reminders.flatMap((r) => nows.map((nowIso) => {
  const now = new Date(nowIso);
  const start = r.at ? new Date(r.at) : nextOccurrence(r, now);
  const offs = alertsOf(r);
  const t = nextTime(r, now);
  return {
    r,
    now: nowIso,
    next: ms(nextOccurrence(r, now)),
    alert: alertJson(nextAlert(r, now)),
    due: alertJson(dueOccurrence(r, now)),
    startup: dueAtStartup(r, now),
    fired: markFired(r, now),
    live: isLiveCached(structuredClone(r), now),
    nextTime: Number.isFinite(t) ? t : null,
    pastEvent: isPastEvent(r, now),
    alerts: offs,
    alertTimes: start ? offs.map((o) => alertTime(start, o, Boolean(r.allDay)).getTime()) : null,
    // 울릴 때 글 (알림 실행기: 울릴 회차가 없으면 켤 때 알림으로)
    text: Object.values(alarmText(r, '메모 제목', dueOccurrence(r, now) ?? { startup: true }, now)),
    describe: describeReminder(r, now),
  };
})));

// 색인(index.json): 메모 묶음 → 파일에 쓰는 글 · 비교 열쇠. generatedAt 은 정해 둔 시각으로 바꿔 둔다 (Rust 에 같은 시각을 준다)
const NOW = '2026-11-17T00:00:00.000Z';
write('indexer', [
  ...indexSets().map(([name, memos]) => {
    const { index, key, text } = indexOutput(memos.map(({ id, file, text: t }) => ({ id, file, ...mf.parseMemoFile(t) })));
    return { name, memos, now: NOW, text: text.replace(`"generatedAt": "${index.generatedAt}"`, `"generatedAt": "${NOW}"`), key };
  }),
  { name: 'guide', text: AGENT_GUIDE },
]);

// 낱말 자르기: 낱말 묶음의 모든 말 × 조사, 받침에 맞지 않는 조사, 영문 · 숫자 · 기호
const JOSA = ['에서부터', '으로부터', '이라는', '이라고', '에게서', '한테서', '까지는', '부터는', '에서는', '으로는', '이에요', '입니다', '했다', '에서', '에게', '한테', '으로', '까지', '부터', '처럼', '보다', '라는', '이나', '하고', '이다', '이랑', '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만', '랑', '나'];
const stems = ['하와이', '소아과', '미술가', '사과', '책', '물', '길', '학교', '서울', '부서', '위원', '실내온도', '길고양이', '여름휴가', '검사결과', '가'];
const tokenTexts = [
  ...[...NOUNS].map((w) => [w, ...['이', '가', '의', '로', '을', '를', '은', '는', '도', '과', '와', '에서', '으로'].map((j) => w + j)].join(' ')),
  ...stems.map((w) => JOSA.map((j) => w + j).join(' ')),
  'Hello, World! THE and for 123 4567 a1 x 가 나 12번 ١٢ İstanbul ÉCOLE café 😀이모지 snake_case e-mail C# 中文을 ㄱㄴ이',
  '그리고 그러나 하지만 그래서 또는 이것 저것 그것 있다 없다 하다 되다 the and for with that this are was you not but from have',
  '', '   ', '회의.회의,회의!회의', '𠀀𠀀가 𠀀이를',
];
write('tokenize', tokenTexts.map((text) => ({ text, tokens: tokenize(text) })));

// 보내기 · 복사용 글 (목록 · 번호 · 체크 · 표 · 인용 · 사진 · 링크 카드 · 수식 · 들여쓰기)
const shareBodies = [...corpus().map((t) => mf.parseMemoFile(t).body),
  '# 장보기\n\n- 우유\n- [ ] 빵\n- [x] 계란\n  - 하위\n\n1. 하나\n2. 둘\n3) 셋\n\n5. 다섯부터\n\n- 느슨한\n\n- 목록',
  '[미리 보기](https://e.com "미리보기") [글](https://a.com) [https://b.com](https://b.com) [파일](attachments/a.pdf) <mailto:a@b.com> <https://c.com>',
  '![](attachments/rec%20one.m4a) ![녹음](attachments/r.m4a) ![](attachments/v.mp4) ![설명](attachments/p.png) ![](attachments/noext) ![](attachments/doc.zip)',
  // (잘못된 %XX 이름은 JS shareText 가 URIError 를 던져 뺀다 — Rust 는 원래 이름을 쓴다)
  '| a | b\\|c |\n|---|:---:|\n| **굵게** | `코드` |',
  '> 인용 *기울임* __밑줄강조__ ~~취소~~\n\n---\n\n$$\nx^2\n$$\n\n$$y$$ 와 \\* 이스케이프 \\\n다음 줄',
  '\u00a0\u00a0들여쓴 글\n    네 칸 들여쓴 문단\n\t탭',
  'snake_case 와 _기울임_ 과 a*b*c 그리고 **굵**게',
  '\n\n\n앞 빈 줄\n\n\n\n뒤 빈 줄\n\n',
  '<u>밑줄</u><mark>형광</mark><span style="color:red">빨강</span><br>다음',
];
write('share_text', shareBodies.map((body) => ({ body, share: shareText(body), copy: hotkeyCopyText(body) })));

// 다른 캘린더 구독 목록 정리 (id 가 없으면 무작위라 모두 id 를 준다)
const feedLists = [
  [{ id: 'g1', url: ' webcal://calendar.google.com/calendar/ical/x/basic.ics ', name: '  내   일정  ' }, { id: 'g2', url: 'WEBCALS://p01-caldav.icloud.com/a b' }],
  [{ id: 'n1', url: 'https://caldav.calendar.naver.com/', user: '  me@naver.com ', pass: 12345, cals: { 내캘린더: { on: false, color: '#ABCDEF' }, '': {}, 회사: { color: 'red' }, 7: null } }],
  [{ id: 'n2', url: 'https://caldav.calendar.naver.com/', user: 'a' }, { id: 'n3', url: 'https://caldav.calendar.naver.com/', user: 'b', name: 5 }, { id: 'n4', url: 'https://caldav.calendar.naver.com', user: 'a' }],
  [{ id: 'o1', url: 'https://outlook.office365.com/owa/calendar/x.ics', color: '#123456', on: false }, { id: 'w', url: 'http://www.example.com:8080/cal?x=1#h' }, { id: 'bad', url: 'ftp://example.com/a.ics' }, { id: 'bad2', url: 'not a url' }, { id: 'x', url: 'https://me.com/c' }, 'text', 3],
  Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, url: `https://example.com/${i}.ics`, name: '가'.repeat(i * 5) })),
  'not a list',
];
write('calendar_feeds', feedLists.map((list) => ({ list, feeds: normalizeFeeds(list) })));
// 전역 단축키 글자: 쓸 만한지 · 보이는 글자 · 메모 창 키로
const accs = ['Control+Alt+C', 'Control+Alt+Space', 'Control+Alt+`', 'Alt+F4', 'Control+C', 'Shift+A', 'A', 'Control+a', 'Control+Control+A', 'Super+Shift+M', 'Control+Shift+P', 'Control+F24', 'Control+F25',
  'Control+F05', 'Alt+Up', 'Control+Alt+\\', 'Control+Alt+=', 'Control+Alt+Enter', 'Meta+A', 'Control+', '+', '', 'Shift+Alt+Shift+Z', 'Control+Alt+1', 'Control+Shift+Alt+Delete', 'Super+L', 'Control+Alt+Delete', 7, null];
write('accelerators', accs.map((acc) => ({ acc, valid: isValidAccelerator(acc), display: displayAccelerator(acc), combo: comboFromAccelerator(acc) })));
const shortcutSets = [undefined, {}, { quickMemo: 'Control+Alt+Space' }, { quickMemo: 'Control+Alt+Space', magic: 'Control+Alt+Space' }, { magic: 'Control+Alt+C', quickMemo: 'Control+Alt+C' },
  { list: 'Control+Alt+C' }, { quickMemo: 'Control+Shift+Q', list: 'Control+Shift+Q' }, { quickMemo: 'Super+K', magic: 'Alt+F4', list: 'Control+Alt+`' }, { quickMemo: 3 }, 'x'];
const guide = '글을 고르고 Ctrl+Alt+C, 매직키는 Ctrl+Alt+Space, 목록은 Ctrl+Alt+` — Ctrl+Alt+CC Ctrl+Alt+`Ctrl+Alt+C';
write('shortcuts', shortcutSets.map((value) => ({ value: value ?? null, normalized: normalizeShortcuts(value), text: withShortcuts(guide, value) })));
// 메모 단축키 칸 정리 · 정하기
const hotkeySets = [null, 'x', { 1: { id: 'a' }, 2: { id: 'b', copy: false }, 3: { id: 'c', copy: false, show: true }, 10: { id: 'd' }, 0: { id: 'e' }, x: { id: 'f' }, 4: { id: '' }, 5: { id: 7 }, 6: null, 9: { id: 'g', copy: 0, show: 1 } },
  { 9: { id: 'a', show: true }, 1: { id: 'b' } }];
const assigns = [['a', '2', {}], ['a', null, {}], ['b', '1', { show: true }], ['z', '9', { copy: false, show: false }], ['z', '10', {}], ['c', '3', { copy: false, show: true }]];
write('memo_hotkeys', hotkeySets.flatMap((raw) => assigns.map(([id, slot, o]) => ({ raw, id, slot, ...o, normalized: normalizeHotkeys(raw), assigned: run(() => assignHotkey(raw, id, slot, o).hotkeys) }))));
// 튜토리얼: 단계(앱이 그대로 쓴다) · 넘어가기 · 기능이 꺼졌을 때 · 묶음 · 다시 볼 때 고를 곳
write('tutorial_steps', TUTORIAL_STEPS);
write('tutorial_events', TUTORIAL_EVENTS);
const tutorialEvents = [...TUTORIAL_EVENTS, 'next', 'skip', 'nope'];
write('tutorial', [-1, ...TUTORIAL_STEPS.keys(), TUTORIAL_STEPS.length].map((index) => ({
  index,
  advance: Object.fromEntries(tutorialEvents.map((e) => [e, advanceTutorial(index, e)])),
  on: TUTORIAL_STEPS[index] ? tutorialStepFor(TUTORIAL_STEPS[index], () => true) : null,
  off: TUTORIAL_STEPS[index] ? tutorialStepFor(TUTORIAL_STEPS[index], () => false) : null,
  chapter: tutorialChapter(TUTORIAL_STEPS, index),
  jumps: tutorialJumps(TUTORIAL_STEPS),
})));
// 링크 미리보기: 웹페이지 앞부분 → 제목 · 설명 · 사진 · 아이콘 (메타 차례 · 상대 주소 · <base> · 글자 참조 · 아이콘 크기 고르기)
const pages = [
  ['<html><head><title> 그냥 &amp; 제목 </title></head>', 'https://www.example.com/a/b.html'],
  ['<meta property="og:title" content="OG 제목"><meta name="twitter:title" content="트위터"><title>태그</title><meta property="og:title" content="둘째">', 'https://example.com/'],
  ['<META NAME="Description" CONTENT=\'설명 &#39;따옴표&#39; &#x1F600;\'><meta property="og:description" content="">', 'http://example.com/x?y=1'],
  ['<meta property="og:image" content="/img/a.png"><meta property="og:image:secure_url" content="https://cdn.example.com/s.png"><meta property="og:site_name" content="사이트">', 'https://example.com/p/'],
  ['<base href="https://other.example/dir/"><meta property="og:image" content="pic.jpg"><link rel="icon" href="fav.png">', 'https://example.com/'],
  ['<link rel="icon" sizes="16x16" href="/16.png"><link rel="apple-touch-icon" href="/apple.png"><link rel="shortcut icon" sizes="48x48" href="/48.png"><link rel="icon" sizes="256x256" href="/256.png">', 'https://example.com/'],
  ['<link rel="icon" sizes="any" href="javascript:alert(1)"><link rel="ICON" href="data:image/png;base64,AA"><meta name=twitter:image content=//cdn.example.com/t.gif>', 'https://example.com/'],
  [`<title>${'가'.repeat(250)}</title><meta name="description" content="${'a b  '.repeat(100)}">`, 'https://example.com/'],
  ['<meta itemprop="name" content="아이템"><meta property="og:title"><title>\n여러\n줄\n</title>', 'https://example.com/'],
  ['', 'https://example.com/'],
  ['<link rel="icon" href="/f.ico">', 'not a url'],
];
const youtubeUrls = ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=short',
  'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'https://YouTube.com/live/dQw4w9WgXcQ?x', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/channel/abc', 'nope'];
const oembeds = ['{"title":" 제목\\n줄 ","author_name":"채널"}', '{"title":5}', 'null', '', `{"title":"${'x'.repeat(210)}"}`];
write('link_preview', [
  ...pages.map(([html, url]) => ({ html, url, preview: parseLinkPreview(html, url) })),
  ...youtubeUrls.map((url) => ({ url, host: hostOf(url), oembedUrl: youtubeOEmbedUrl(url), stale: staleYoutubeEntry(url, { title: 'x' }), fresh: staleYoutubeEntry(url, { kind: 'page' }),
    oembeds: oembeds.map((j) => parseYoutubeOEmbed(j, url)) })),
  ...[['text/html; charset=EUC-KR', ''], ['text/html', '<meta charset="Shift_JIS">'], ['text/html', '<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">'], ['', ''], ['', 'x']]
    .map(([type, head]) => ({ type, head, charset: detectCharset(type, head) })),
  ...['image/PNG; x=1', 'image/jpeg', 'image/x-icon', 'text/html', '', ' image/svg+xml '].map((type) => ({ type, ext: imageExtFromType(type) })),
  ...['https://e.com/a.JPEG', 'https://e.com/a.png?x=1', 'https://e.com/a.tiff', 'https://e.com/a', 'https://e.com/a.ico', 'nope'].map((imageUrl) => ({ imageUrl, ext: imageExtFromUrl(imageUrl) })),
]);

// 업데이트 뒤 "개선된 점" (README 이력 표 꼴 — 진짜 README 는 릴리스마다 바뀌어 고정한 표로)
const readme = [
  '| 태그 | 날짜 | 단계 | 내용 |', '|---|---|---|---|',
  '| `v0.88.0` | 2026-11-17 | 정식 | **새 기능 (PC 0.88.0)** 설명. 더 |',
  '| `v0.87.1` | 2026-11-10 | 정식 | **고침** (휴대폰 0.47.0) |\r',
  '| `v0.87.0` | 2026-11-01 | 정식 | 제목 없는 옛 행 |',
  '| `v0.9.0` | 2025-01-01 | 정식 | **옛 버전** |',
  '| `v0.10.0` | 2025-02-01 | 정식 | **열 번째** |',
  '| `v0.86.0` | 2026-10-01 | 정식 | **여섯** |', '| `v0.85.0` | 2026-09-01 | 정식 | **다섯** |', '| `v0.84.0` | 2026-08-01 | 정식 | **넷** |',
  '| `v1.0.0` | 2027-01-01 | 정식 | **미래** |', '| v0.83.0 | 2026-07-01 | 정식 | **틀린 꼴** |',
].join('\n');
write('release_notes', [[null, '0.88.0'], ['0.85.0', '0.88.0'], ['0.88.0', '0.88.0'], ['0.9.0', '0.20.0'], [null, '9.9.9']]
  .map(([from, to]) => ({ readme, from, to, titles: versionTitles(readme, from, to) })));
// 태그 추천 · 저절로 다는 태그: 메모 묶음 × 새 메모 (본문 · id)
const tagSets = [
  ['work', [
    { id: 'a', body: '# 주간 회의\n\n프로젝트 일정 회의 안건 정리 #업무 #회의' },
    { id: 'b', body: '# 기획 회의록\n\n출시 일정과 디자인 검토 회의 #업무 #회의' },
    { id: 'c', body: '# 장보기\n\n우유 계란 대파 두부 #장보기 #집' },
    { id: 'd', body: '# 마트\n\n두부 우유 사과 #장보기' },
    { id: 'e', body: '# 예전 화면\n\n오류 화면 #스크린샷' },
    { id: 'f', body: '# MemoKing 개발\n\n코딩 버그 수정 배포 #MemoKing #개발 #업무' },
    { id: 'g', body: '# 프로젝트 회고\n\n일정 지연 원인 #프로잭트 #업무' },
    { id: 'h', body: '# 제주 여행\n\n숙소 예약 렌터카 #여행 #가족' },
  ]],
  ['corpus', corpus().map((text, i) => ({ id: `c${i}`, body: mf.parseMemoFile(text).body }))],
  ['none', []],
];
const tagTargets = [
  ['# 내일 회의\n\n디자인 검토 회의 준비할 것', null], ['# 저녁거리\n\n우유 두부 계란 사오기', null], ['짧음', null],
  ['# 회의 준비\n\n안건 회의 정리 #회의', null], ['# 여행 계획\n\n제주도 여행 숙소 예약 여행 일정', null],
  ['# 거래처 미팅\n\n다음 분기 계획 미팅 메모', null], ['![화면 캡처](attachments/a.png)', null], ['오류 화면 #스크린샷', null],
  ['# 요리\n\n김치찌개 끓이는 법 정리해 둔 것', null], ['# 주간 회의\n\n프로젝트 일정 회의 안건 정리 #업무 #회의', 'a'],
  ['https://example.com/page 회의자료.txt 링크 모음 www.naver.com 정리', null], ['폰에서도 PC에서고침 메모킹 프로잭트 배포했어요 2026년', null],
  ['# memoking 버그\n\n배포 전에 코딩 다시 확인하기 #개발', 'f'],
  ...corpus().slice(0, 40).map((t, i) => [mf.parseMemoFile(t).body, `c${i}`]),
];
write('tag_sets', tagSets.map(([name, memos]) => ({ name, memos })));
const SOURCES = ['capture', 'link', 'audio', 'share', null];
write('tag_suggest', tagSets.flatMap(([set, memos]) => tagTargets.map(([body, id]) => ({
  set, body, id,
  suggest: suggestTagsFor(body, memos, { excludeId: id ?? undefined }),
  auto: SOURCES.map((source) => autoTagsFor(body, memos, { source: source ?? undefined, excludeId: id ?? undefined })),
}))));
const existingTags = [{ name: 'MemoKing', count: 3 }, { name: '회의', count: 5 }, { name: '장보기', count: 2 }, { name: '프로젝트', count: 2 }, { name: '업무', count: 1 }, { name: '스크린샷', count: 1 }];
write('tag_match', ['memoking', '미팅', '회의록', '쇼핑', '프로잭트', '여행', '', 'Work', '캡쳐', '회'].map((word) => {
  const m = matchExisting(word, existingTags);
  return { word, name: m ? m.name : null, rank: m ? m.rank : null };
}));

// 로컬 AI 에 묻는 말 · 답 거르기 (llama-client · ai-write · ai-tags)
const thinks = ['답', '  <think>생각\n중</think>\n답 ', '<think>아직 생각 중', '앞 <think>a</think> 가운데 <think>b</think> 끝', ''];
const sse = ['data: {"choices":[{"delta":{"content":"안녕"}}]}', 'data: [DONE]', '', ': ping', 'data: {"choices":[{"delta":{}}]}', 'data:   {"choices":[]}  '];
const logs = [["llama_model_load: error: unknown model architecture: 'gemma9'", 1], ['CUDA error: out of memory', 3221225477], ['ggml: failed to allocate buffer', -1], ['something else', 1]];
const writeTexts = ['', '오늘 회의 했는데 됬어요.', '되니 ?', '#업무 https://a.com/x 회의록 정리 해야됨', '   ', '긴 글 '.repeat(400)];
const fixes = [['오늘 회의 했는데 됬어요.', '오늘 회의했는데 됐어요.'], ['되니 ?', '네, 잘 돼요'], ['되니 ?', '되니?'], ['#업무 회의', '업무 회의'], ['회의록', '會議錄'], ['abc', ''],
  ['https://a.com/x 링크', 'https://a.com/x 링크.'], ['짧은 글', '아주 아주 길게 늘어난 다른 글'], ['한자 漢字 그대로', '한자 漢字 그대로.'], ['맞춤법 검사 할 글 입니다', '맞춤법 검사할 글입니다']];
const outs = ['  네, 요청하신 대로 정리했습니다:\n\n## 결과\n- 하나', '```markdown\n## 제목\n본문\n```', '```\n코드\n```', '다음은 요약입니다：\n내용', '그대로', '알겠습니다. 아래는 표예요:\n\n| a |'];
const drafts = [
  { title: '회의', body: '', request: '', selection: '' },
  { title: '', body: '오늘 회의 내용\n- 일정 확정', request: '요약해 줘', selection: '' },
  { title: '장보기', body: '우유', request: '이어서 써 줘', selection: '' },
  { title: '장보기', body: '우유', request: '이어서 목록으로 정리', selection: '' },
  { title: 't', body: '본문', request: '영어로', selection: '  고른 글  ' },
  { title: '긴 글', body: '가'.repeat(2000), request: '짧게', selection: '' },
  { title: '', body: '   ', request: '  ', selection: '' },
];
write('ai_text', [
  ...thinks.map((text) => ({ kind: 'noThink', text, out: noThink(text) })),
  ...sse.map((text) => ({ kind: 'sse', text, out: sseText(text) })),
  ...logs.map(([text, code]) => ({ kind: 'engine', text, code: String(code), out: engineError(text, code) })),
  ...outs.map((text) => ({ kind: 'clean', text, out: cleanWriteOutput(text) })),
  ...fixes.map(([before, after]) => ({ kind: 'fix', text: before, after, out: plausibleFix(before, after) })),
  ...writeTexts.map((text) => ({ kind: 'spell', text, out: spellMessages(text) })),
  ...['해요체', '합니다체', '간결체', '보고서체', '반말체'].map((style) => ({ kind: 'style', text: '글', style, out: styleMessages('글', style) })),
  ...drafts.map((d) => ({ kind: 'draft', ...d, out: draftMessages(d) })),
  { kind: 'body', out: chatBody([{ role: 'user', content: 'x' }], { maxTokens: 80 }) },
  { kind: 'bodySchema', out: chatBody([], { maxTokens: 60, temperature: 0, schema: { type: 'object' }, stream: true }) },
  ...['# 제목\n\n본문\n', '# 제목\n\n#회의\n', '#회의  ', '', '본문 #안\n\n\n', '# 제목\n\n#회의 #업무 #일정\n\n', '  #a #B\t#c  \n끝\n#b #d'].flatMap((body) => [
    { kind: 'append', text: body, names: ['업무', '1', '회의'], out: appendTags(body, ['업무', '1', '회의']) },
    { kind: 'append', text: body, names: [], out: appendTags(body, []) },
    { kind: 'remove', text: body, names: ['회의', 'b', '업무'], out: removeTags(body, ['회의', 'b', '업무']) },
  ]),
]);
const answers = ['{"tags":["회의","#일정 관리","메모","프로잭트","캡쳐","x",5,null,"회의록","업무","가족"]}', '{"tags":[]}', 'not json', '{"tags":"회의"}', '{"tags":["미팅","장보기","여행계획","스크린샷"]}'];
write('ai_tags', tagSets.flatMap(([set, memos]) => tagTargets.slice(0, 14).map(([body, id]) => {
  const req = aiTagRequest(body, memos, { excludeId: id ?? undefined });
  return { set, body, id, messages: req.messages, schema: req.schema, existing: req.existing, grounded: [...req.grounded], results: answers.map((a) => aiTagResult(a, req.existing, body, req.grounded)) };
})));

// AI 검색: 조각 나누기 · 물은 때 · 찾기 · 답 묻는 말 · 답 다듬기 ("지금" 은 정해 둔 시각)
const RAG_NOW = new Date('2026-11-18T15:00:00+09:00');
const ragMemos = [
  { id: 'w', body: '# 와이파이\n\n집 공유기 비밀번호는 abc12345 이다.\n손님용은 guest2026.', updated: '2026-11-17T10:00:00+09:00' },
  { id: 'r', body: '# 출시 회의\n\n신제품 출시일은 12월 3일로 정했다. 담당자는 김대리.\n마케팅 예산 3천만 원.', updated: '2026-11-12T09:00:00+09:00' },
  { id: 'm', body: '# 월세\n\n매달 25일 월세 80만 원 이체. 계좌는 국민 123-45.', updated: '2026-10-20T09:00:00+09:00' },
  { id: 'c', body: `# 긴 메모\n\n${Array.from({ length: 30 }, (_, i) => `${i}번째 줄 회의 내용과 일정 정리 문장입니다.`).join('\n')}`, updated: '2026-11-18T08:00:00+09:00' },
  { id: 't', body: '# 제주 여행\n\n숙소는 호텔, 비행기는 오전 9시. 렌터카 예약 완료!', updated: '2026-01-05T09:00:00+09:00' },
  { id: 'e', body: '', updated: '2026-11-18T08:00:00+09:00' },
  ...corpus().slice(0, 30).map((t, i) => ({ id: `c${i}`, body: mf.parseMemoFile(t).body, updated: '2026-11-11T09:00:00+09:00' })),
];
const ragChunks = ragMemos.flatMap((m) => chunkMemo(m.body).map((text) => ({ id: m.id, title: mf.extractTitle(m.body), text, updated: m.updated })));
const ragIndex = ragBuildIndex(ragChunks.map((c) => ({ ...c })));
const ragRelated = { w: [{ id: 'm', score: 0.8 }, { id: 'zz', score: 1 }, { id: 'r', score: 0.5 }], r: [{ id: 't', score: 0.4 }], m: [{ id: 'w', score: 0.9 }] };
const ragQuestions = ['인터넷 암호 뭐였지', '출시일 언제야', '월세 얼마야', '지난주 회의 내용', '오늘 회의', '차 정비', '이번 달 일정', '올해 여행', '어제 뭐 했지', '그저께', '이번주 일정', '저번 달 월세', '없는말없는말', '뭐야', ''];
const ragWords = [[], ['비번', '공유기'], ['  ', 7, null]];
const ragAnswers = ['비밀번호는 abc12345예요 [1]', '메모에서 찾지 못했어요.', '답만 있어요', '[9] 없는 번호 [2]', '', '없어요', '첫째 [1][3] 둘째'];
write('rag_chunks', ragMemos.map((m) => ({ id: m.id, updated: m.updated, body: m.body, chunks: chunkMemo(m.body) })));
write('rag', ragQuestions.flatMap((q) => ragWords.map((words) => {
  const w = expandResult(JSON.stringify({ words }));
  const picked = ragRetrieve(q, ragIndex, { words: w, related: (id) => ragRelated[id] ?? [], limit: 4, now: RAG_NOW });
  const p = askedPeriod(q, RAG_NOW);
  return {
    q, words, expanded: w, period: p && [p.from.getTime(), p.to.getTime()], picked,
    messages: ragMessages(q, picked, RAG_NOW), finished: ragAnswers.map((a) => finishAnswer(a, q, picked, w)),
  };
})).concat([{ q: 'expand', expand: ['{"words":["a"," b ",1,null,"","c","d","e","f","g"]}', '{"words":"x"}', 'nope'].map(expandResult), messages: expandMessages('질문') }]));
// Google Drive 동기화 (desktop/drive/sync-engine.js) — 장면은 drive.mjs
write('drive_sync', await driveCases());
// 메모 스택 (desktop/stacks.js): 읽은 그대로 쓴 글 + 차례로 한 일마다의 답과 스택들. 새 스택 id 는 차례 번호 (s1, s2 …)
{
  const memos = ['a', 'b', 'c', 'd', 'e', 'f'];
  const files = [
    null, 'not json', '{"stacks":[{"memos":["a"]}]}',
    JSON.stringify({ version: 1, stacks: [{ id: 'x', memos: ['a', 'b', 'gone', 'a'], active: 'gone' }, { memos: ['b', 'c', 'd'], active: 'd' }, { id: 0, memos: ['e', 'f'] }, { id: 7, memos: ['c', 'd', 3] }] }),
    JSON.stringify({ stacks: [{ id: 's', memos: ['a', 'b', 'c'], active: 'b' }, { id: 't', memos: ['d', 'e'], active: 'e' }] }),
  ];
  const scripts = [
    [['merge', 'a', ['b']], ['merge', 'a', ['c'], 'a'], ['addAfter', 'c', 'd'], ['reorder', 'd', 0], ['reorder', 'd', '2.7'], ['reorder', 'd', 'x'], ['reorder', 'a', -5], ['reorder', 'a', 99], ['neighbor', 'a', 1], ['neighbor', 'a', -1], ['setActive', 'b'], ['remove', 'b'], ['remove', 'c'], ['remove', 'a'], ['remove', 'z']],
    [['merge', 'a', ['d']], ['merge', 'e', ['b', 'c']], ['merge', 'd', ['e']], ['merge', 'b', ['a', 'f']], ['merge', 'c', []], ['addAfter', 'f', 'b'], ['remove', 'd'], ['neighbor', 'zz', 1]],
  ];
  const open = (file) => {
    let n = 0;
    const io = { saved: null };
    const store = new StackStore({ read: () => file, write: (t) => (io.saved = t), newId: () => `s${++n}` }).load((id) => memos.includes(id));
    return { store, io };
  };
  const cases = [];
  for (const file of files) {
    const { store: first, io } = open(file);
    first.save();
    for (const ops of scripts) {
      const { store } = open(file);
      const steps = ops.map(([op, ...args]) => {
        const r = op === 'merge' ? store.merge(args[0], args[1], args.length > 2 ? { activate: args[2] } : undefined) : store[op](...args);
        return { ret: r === undefined ? null : structuredClone(r), stacks: structuredClone(store.all()) };
      });
      cases.push({ file, loaded: io.saved, ops, steps });
    }
  }
  write('stacks', cases);
}

// 창 자리: 끌어 놓은 메모 창 (placement.js) · 상태 말풍선 (bubble-place.js)
{
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const second = { x: -1280, y: 100, width: 1280, height: 984 };
  const points = [{ x: 500, y: 300 }, { x: 10, y: 5 }, { x: 1919, y: 1039 }, { x: 40.5, y: 18.5 }, { x: -600, y: 500 }];
  const sizes = [{ width: 340, height: 380 }, { width: 2000, height: 1200 }];
  const cases = [];
  for (const p of points) for (const s of sizes) for (const a of [area, second]) cases.push({ drop: { p, s, a, bounds: dropBounds(p, s, a), inside: isInside(p, a) } });
  const notes = [{ x: 400, y: 400, width: 340, height: 380 }, { x: 400, y: 50, width: 340, height: 380 }, { x: 1500, y: 50, width: 340, height: 380 }, { x: 0, y: 20, width: 1900, height: 900 }, { x: 10, y: 10, width: 300, height: 300 }];
  for (const b of notes) {
    for (const anchor of [b.x + 70, b.x + 2.5, 1910]) {
      for (const sticker of [null, { x: b.x + 138, y: b.y - 26, width: 64, height: 52 }]) {
        for (const barH of [36, 45]) cases.push({ bubble: { b, area, anchor, barH, sticker, r: placeBubble(b, area, anchor, barH, sticker) } });
      }
    }
  }
  write('placement', cases);
}
// 알림 보관함: Windows 토스트 XML · 앱 이름 · 찾기, 팝업 알림 창의 글 → 보관함 항목, 같은 알림 거르기, 이름 맞추기
const toasts = [
  '<toast><visual><binding template="ToastGeneric"><text>김대리</text><text>회의 자료 &amp; 일정 &lt;오늘&gt;</text><text></text><image placement="appLogoOverride" src="file:///C:/Temp/a.png"/><image src="b.png"/></binding></visual></toast>',
  '<toast launch="x"><visual><binding><text hint-style="x"><b>굵은</b> 제목</text><text>둘\n째 &nbsp; &#x1F600; &#99999999;</text><image src="only&amp;one.jpg"/></binding></visual></toast>',
  '<TOAST><text>  </text></TOAST>', '<tile><text>타일</text></tile>', '<toast><text>제목만</text></toast>', '',
];
const appIds = ['Microsoft.Teams_8wekyb3d8bbwe!MSTeams', 'com.daou.msn', 'C:\\Program Files\\App\\kakao.EXE', 'Chrome', 'a/b/c.d.e', '', '!', 'x!', 'Folder\\'];
const entryList = [{ app: '카카오톡', title: '김대리 (영업팀)', body: '회의 자료 보냈어요' }, { app: 'Teams', title: 'Hello World', body: '' }];
const queries2 = ['', '  ', '김대리', 'hello', 'WORLD teams', '회의 없음', '카카오톡 자료'];
const lineSets = [['김대리', '회의 자료 보냈어요', '내일 봬요'], ['카카오톡', '', '김대리', '오후 3:12', '15:12', '3:05 pm', '회의 자료 보냈어요', '답장', '닫기'], ['  김대리 ', '안녕\t 하세요', '안녕 하세요'], ['김대리'], [], ['카카오톡', '오전 9:01'], ['가'.repeat(300), '나'.repeat(3000)], [null, 12, '앱', 'x'], ['😀'.repeat(150)]];
const box = (text, x, y, h = 14) => ({ text, x, y, w: String(text).length * 12, h });
const S = { width: 340, height: 110, appName: '카카오톡' };
const P = { width: 330, height: 140, appName: '카카오톡', profileTop: 30 };
const kakao = [
  [[box('가족방', 70, 12), box('엄마', 70, 34), box('저녁 7시에 와', 70, 62), box('0', 290, 10), box('x', 316, 10)], S],
  [[box('김대리', 70, 12), box('김대리', 70, 34), box('회의 자료 보냈어요', 70, 62), box('확인 부탁드려요', 70, 80)], S],
  [[box('김대리', 70, 14), box('넵', 70, 62)], S],
  [[box('가족방', 70, 12), box('아빠', 70, 34)], S],
  [[box('김대리', 70, 12), box('—', 70, 40), box('ㅋㅋㅋ', 70, 62), box('답장', 250, 90), box('o', 20, 50), box('오후 3:12', 70, 96)], S],
  [[box('프로젝트', 70, 12), box('알림', 300, 12), box('박과장', 70, 34), box('내일', 70, 62, 15), box('10시요', 120, 63, 14)], S],
  [[], S], [[box('0', 290, 10), box('카카오톡', 70, 12)], S], [[box('김대리 ×', 70, 12)], {}],
  [[box('우리 여보', 14, 8, 11), box('우리 여보', 64, 32, 13), box('혹시 오늘 저녁도 괜찮겠니', 64, 54, 12), box('메시지 입력', 20, 104, 12)], P],
  [[box('우리 여부', 14, 8, 11), box('우리 여보', 64, 32, 13), box('혹시', 64, 54, 12)], P],
  [[box('회사 동기방 ×', 14, 8, 11), box('김대리', 64, 32, 13), box('회의 자료 보냈어요', 64, 54, 12)], P],
  [[box('Team AB', 14, 8, 11), box('김대리', 64, 32, 13)], P], [[box('우리 가족 x', 14, 8, 11), box('김대리 o', 64, 32, 13), box('사진', 64, 54)], P],
  [[box('김대리', 70, 12), box('김대러', 70, 30), box('김대리', 70, 64), box('안녕', 70, 80)], S],
  [[{ text: 5, x: '7', y: null }, { text: '가나', x: 'a', y: 20, h: 0 }, box('다라', 10, 22, 30)], S],
];
const now = 1_000_000;
const recent = [
  { app: '카카오톡', hwnd: 7, title: '김대리', body: '회의 자료 보냈어요', at: now - 2000, via: 'uia' },
  { app: '카카오톡', hwnd: 9, title: '박지민', body: '혹시 오늘 저녁도 어제와 같아도 괜찮겠니', at: now - 3000, via: 'ocr' },
  { app: 'Teams', title: '😀𠀀가', body: '', at: now - 200_000 },
];
const probes = [
  { app: '카카오톡', hwnd: 7, title: '김대리 (영업팀)', body: '회의 자료 보냈어요' }, { app: '카카오톡', hwnd: 7, title: '김대리', body: '회의자료 보냈어요.' },
  { app: '카카오톡', hwnd: 8, title: '김대리 (영업팀)', body: '회의 자료 보냈어요' }, { app: '카카오톡', hwnd: 7, title: '김대리', body: '내일 봬요' },
  { app: '카카오톡', hwnd: 9, title: '박지민', body: '흑시 오늘 저녁도 어제와 같아도 괜찮겠나' }, { app: '카카오톡', title: '박지민', body: '내일 회의 10시로 바뀌었어요' },
  { app: 'Teams', title: '😀𠀀가', body: '' }, { app: '카카오톡', hwnd: 0, title: '', body: '' },
];
const titles = [['김대리 (회사 동기방)', '박과장 (회사 동기방)', '우리 여보'], ['김대리 (회사 등기방)', '김대리 (회사 동기방)'], ['a (회사 동기방)', 'b (회사 동기방)', 'c (회사 동기방)', 'd (회사 동기방)', 'e (회사 등기방)'], ['김대리'], []];
const probeTitles = ['김대리 (회사 등기방)', '김대리 (회사 동기방', '우리 여부', '김대 (회사 동기방)', '이부장 (볼링 동호회)', '김대리 (회사 동기방)', 'x (회사 등기방)', '  김대리  ', '김 대리 (회사동기방)', ''];
const { parseToastXml, fallbackAppName, matchesQuery, fileTimeToMs } = await import('../../app/js/core/notifications.js');
const pn = await import('../../app/js/core/popup-notify.js');
write('notify', [
  ...toasts.map((xml) => ({ kind: 'toast', xml, out: parseToastXml(xml) })),
  ...appIds.map((id) => ({ kind: 'app', id, out: fallbackAppName(id) })),
  ...queries2.flatMap((q) => entryList.map((e) => ({ kind: 'query', e, q, out: matchesQuery(e, q) }))),
  ...['0', '133000000000000000', '116444736000000000'].map((t) => ({ kind: 'filetime', t, out: fileTimeToMs(t) })),
  ...['KakaoTalk', 'Other', null].map((p) => ({ kind: 'popupApp', p, out: pn.popupAppName(p ?? undefined) })),
  ...lineSets.map((lines) => ({ kind: 'lines', lines, out: pn.popupToEntry(lines, { appName: '앱' }) })),
  ...kakao.map(([boxes, o]) => ({ kind: 'kakao', boxes, o, out: pn.kakaoEntry(boxes, o) })),
  ...probes.map((e) => ({ kind: 'repeat', recent, e, now, out: recent.indexOf(pn.findRepeat(recent, e, now)) })),
  ...[['ocr', 'uia'], ['uia', 'ocr'], ['ocr', 'ocr'], ['msaa', 'uia'], ['ocr', ''], ['ocr', null]].map(([a, b]) => ({ kind: 'better', a, b, out: pn.betterReading({ via: a }, { via: b }) })),
  ...titles.flatMap((ts) => probeTitles.map((t) => ({ kind: 'title', ts, t, out: pn.correctTitle(t, pn.knownNames(ts)) }))),
]);

// 자동 업데이트: 오류 글 · "나중에" 숨김 · 릴리스 노트
const up = await import('../../desktop/updater.js');
const errs = ['getaddrinfo ENOTFOUND github.com', 'net::ERR_INTERNET_DISCONNECTED', 'New version is not signed by the application owner', 'HttpError: 404', 'Cannot find latest.yml', 'Socket hang up', 'disk full', ''];
const snoozes = [null, { version: '1.2.0', until: 2000 }, { version: '1.2.0', until: 500 }, { version: '1.3.0', until: 2000 }];
const notes = ['<h2>바뀐 점</h2><ul><li>알림 &amp; 캡처</li><li>PDF</li></ul><p>둘째<br>줄</p>', '그냥 글\n\n\n  \n다음 &lt;b&gt;', '', '가'.repeat(4100), '  <br/>  '];
write('update', [
  ...errs.map((e) => ({ kind: 'error', e, out: up.updateErrorText(new Error(e)) })),
  ...snoozes.map((s) => ({ kind: 'snooze', s, out: up.isSnoozed(s, '1.2.0', 1000) })),
  ...notes.map((n) => ({ kind: 'notes', n, out: up.notesText(n) })),
]);

// 받아쓰기: 문장부호 · 화자 이름표 · 소리 다듬기 · 말모음으로 고치기 · 음성 카드의 글 바꾸기
{
  const tl = await import('../../app/js/core/transcript-lines.js');
  const tf = await import('../../app/js/core/transcript-fix.js');
  const { replaceTranscript } = await import('../../app/js/core/voice-card.js');
  const parts = ['', '  ', '안녕하세요', '회의 시작할까', '좋아요!', '그럼 그렇게 하죠', '진짜', 'hello', '이거 맞나요 ', '네,', '끝.', '뭐 할래', '음…', '괜찮은지'];
  const L = (text, start, end, speaker) => ({ text, start, end, ...(speaker == null ? {} : { speaker }) });
  const lineSets = [
    [], [L('안녕하세요', 0, 1)], [L('안녕하세요', 0, 1.2, 2), L('네 반가워요', 1.2, 2.5, 5), L('  ', 2.5, 3, 7), L('어 그래요', 3, 4, 0), L('다음', 4, 5, 5)],
    [L('혼자', 0, 1, 1), L('말해요', 1, 2, 1)], [L('모름', 0, 1, 0), L('하나', 1, 2, 3), L('둘', 2, 3, 4), L('둘 이어서', 3, 4, 4)],
  ];
  const plain = [L('하나', 0, 1.2), L('둘', 1.2, 2.5), L('셋', 2.5, 3), L('넷', 3, 4), L('다섯', 4, 5), L('여섯', 9.5, 12)];
  const segSets = [[], [{ start: 0, end: 1.5, speaker: 3 }, { start: 1.5, end: 9, speaker: 0 }], [{ start: 0.5, end: 1, speaker: 1 }, { start: 0, end: 0.6, speaker: 2 }, { start: 3, end: 4.5, speaker: 2 }, { start: 4.4, end: 5, speaker: 1 }], [{ start: 10, end: 11, speaker: 0 }]];
  let seed = 7;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647) * 2 - 1;
  const chunks = [[200, 0.001], [200, 0.3], [200, 0.02], [0, 0], [200, 0.9], [200, 0.003], [200, 0.05], [200, 0.4]]
    .map(([n, amp]) => Float32Array.from({ length: n }, (_, i) => amp * (Math.sin(i / 7) * 0.7 + rnd() * 0.3)));
  const cond = new tl.SpeechConditioner(16000);
  const condCase = { kind: 'cond', input: chunks.map((c) => [...c]), out: chunks.map((c) => [...cond.process(Float32Array.from(c))]) };
  const memos = [
    { body: '# 메모킹 회의\n\n#메모킹 #카카오 #김민준\n오늘 메모장 정리' },
    { body: '# 카카오 미팅\n## 메모킹 출시\n#메모킹 #김민준 #업무일지' },
    { body: '# 업무일지 정리\n#업무일지 #프로젝트 Memoking release' },
    { body: '# Memoking release notes\n## 회의록 작성\n#회의록 #Alpha #alpha 2024 12' },
  ];
  const corpusMemos = corpus().map((t) => ({ body: mf.parseMemoFile(t).body }));
  const vocabOut = (v) => ({ terms: v, known: [...v.known].sort() });
  const vocab = tf.vocabularyFrom(memos);
  const texts = ['메모킹 회의', '메모깅 출시했어요', '카카우 미팅 잡았나요', '김민줜 씨가 말했다 .그리고', '화자 1: 업무일찌 정리 했어요 .  다음\n\n\n\n화자 2:  메모장 좋아요', '  메모깅을   봤어요?네  ', '', '프로젝드 진행 3.5배', '회의롞\t회의록!'];
  const bodies = ['앞\n> ![녹음](attachments/a.m4a)\n>\n> 옛 글\n>\n> 둘째\n뒤', '![녹음](attachments/a.m4a) 같은 줄 글\n다음', '![녹음](<attachments/b c.m4a>)', '> ![녹음](attachments/a.m4a)', '없음', '> ![녹음](attachments/a.m4a)\n> 붙은 글'];
  const transcripts = ['화자 1: 안녕하세요.\n화자 2: #태그 *별* 1. 목록\n- 줄', '', '  \n\n', '그냥 한 줄 [링크](x) <b> | ~ $ \\ _밑줄_ `코드`', '  # 제목처럼\n> 인용처럼\n12) 번호'];
  write('transcript', [
    ...parts.map((p) => ({ kind: 'punctuate', p, out: tl.punctuate(p) })),
    ...lineSets.map((lines) => ({ kind: 'join', lines, out: tl.joinTranscript(lines) })),
    ...segSets.map((segs) => ({ kind: 'label', lines: plain, segs, out: tl.labelSpeakers(plain, segs) })),
    condCase,
    { kind: 'vocab', memos, out: vocabOut(vocab) },
    { kind: 'vocab', memos: corpusMemos, out: vocabOut(tf.vocabularyFrom(corpusMemos)) },
    ...texts.flatMap((t) => [{ kind: 'fix', t, memos, out: tf.fixTranscript(t, vocab) }, { kind: 'fix', t, memos: [], out: tf.fixTranscript(t, []) }]),
    ...bodies.flatMap((b) => ['attachments/a.m4a', 'attachments/b c.m4a'].flatMap((src) => transcripts.map((tr) => ({ kind: 'replace', b, src, tr, out: replaceTranscript(b, src, tr) })))),
  ]);
}
