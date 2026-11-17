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
import { corpus, yamlStrings } from './corpus.mjs';

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
