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
import { hotkeyCopyText } from '../../app/js/core/memo-hotkeys.js';
import { normalizeReminder, nextOccurrence, nextAlert, dueOccurrence, dueAtStartup, markFired, isLiveCached, nextTime, isPastEvent, alertsOf, alertTime, pendingAlerts, fallbackAlert } from '../../app/js/core/reminders.js';
import { indexOutput, tokenize, AGENT_GUIDE } from '../../app/js/core/indexer.js';
import { NOUNS } from '../../app/js/core/korean-nouns.js';
import { parseLinkPreview, detectCharset, hostOf, youtubeOEmbedUrl, parseYoutubeOEmbed, staleYoutubeEntry } from '../../app/js/core/link-preview.js';
import { imageExtFromType, imageExtFromUrl } from '../../app/js/core/remote-images.js';
import { versionTitles } from '../../app/js/core/release-notes.js';
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
