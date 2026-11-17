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
import { hotkeyCopyText, normalizeHotkeys, assignHotkey } from '../../app/js/core/memo-hotkeys.js';
import { isValidAccelerator, displayAccelerator, normalizeShortcuts, withShortcuts } from '../../app/js/core/accelerators.js';
import { comboFromAccelerator } from '../../app/js/core/keymap.js';
import { TUTORIAL_STEPS, TUTORIAL_EVENTS, tutorialStepFor, tutorialChapter, tutorialJumps, advanceTutorial } from '../../app/js/core/tutorial.js';
import { normalizeReminder, nextOccurrence, nextAlert, dueOccurrence, dueAtStartup, markFired, isLiveCached, nextTime, isPastEvent, alertsOf, alertTime, pendingAlerts, fallbackAlert } from '../../app/js/core/reminders.js';
import { indexOutput, tokenize, AGENT_GUIDE } from '../../app/js/core/indexer.js';
import { NOUNS } from '../../app/js/core/korean-nouns.js';
import { corpus, yamlStrings, indexSets } from './corpus.mjs';

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
    pending: start ? pendingAlerts(offs, start, { repeat: r.kind === 'repeat', now, fallback: fallbackAlert(Boolean(r.allDay)), allDay: Boolean(r.allDay) }) : null,
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
