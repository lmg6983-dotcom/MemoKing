// JS ↔ Rust 비교에 넣는 입력들. 고칠 때는 gen.mjs 를 다시 돌린다.
import fs from 'node:fs';
import path from 'node:path';

const sample = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'android', 'web', 'dev', 'roundtrip-sample.md'), 'utf8');

// 같은 씨앗이면 늘 같은 글자들 (fixtures 가 돌릴 때마다 바뀌지 않게)
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function yamlStrings() {
  const fixed = ['plain', '', ' lead', 'trail ', 'a: b', 'a #b', '#x', '- x', '-x', '-', '?', ':', 'true', 'True', 'TRUE', 'false', 'null', 'Null', 'NULL', '~',
    '123', '-7', '+1', '1.5', '.5', '-.5', '1.', '1e3', '1E-3', '0x1F', '0o17', '0123', '.inf', '-.Inf', '.nan', 'NaN', 'yes', 'no', 'on', 'off', 'y',
    "it's", 'say "hi"', '"start', "'start", 'both \' and "', 'multi\nline', 'trailing\n', 'two\n\n', '\nlead nl', ' sp\nnext', 'a\n b', 'tab\there', '\ttab',
    '2026-09-29T17:30:12+09:00', '2026-09-29', '한글 메모', '@at', '`bt', '*star', '&amp', '!bang', '%pct', '{a}', '[a]', 'a,b', 'a: ', ':x', 'x:', '?q', '? q', '|pipe', '>gt',
    'a\\b', 'emoji 😀', '\u0007bell', '\u0000nul', 'del\u007f', 'x"y', 'a # b', 'a#b', 'key: value: more', '---', '...', '--- x', 'a\r\nb', 'cr\r', ' nbsp', 'zw​',
    'ends with \\', 'C# 언어', '100%', '<tag>', '=eq', 'a=b', ',lead comma', ']x', 'x]', 'x}', '{x', 'a | b', 'a > b', 'x y', '﻿bom'];
  const alphabet = ['a', 'Z', '0', '9', ' ', ' ', '-', ':', '#', '"', "'", '\\', '\n', '\t', '?', '!', '&', '*', '[', ']', '{', '}', ',', '|', '>', '%', '@', '`', '.', '+', '가', '😀', '~', '='];
  const rand = prng(20261117);
  const generated = [];
  for (let i = 0; i < 1500; i++) {
    const len = 1 + Math.floor(rand() * 8);
    let s = '';
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
    generated.push(s);
  }
  return [...new Set([...fixed, ...generated])];
}

const fm = (yaml, body = '본문') => `---\n${yaml}\n---\n${body}`;

export function corpus() {
  const files = [
    sample,
    fm('id: abc\ncreated: 2026-09-29T17:30:12+09:00\nupdated: 2026-09-30T08:00:00+09:00\ncolor: green', sample),
    fm('id: a1\ncolor: purple\npinned: true\nlinks:\n  - b\n  - b\n  - ""\n  - 3\n  - c'),
    fm('id: a2\ncolor: nope\npinned: "true"\nmode: WORK\nday: 2026-02-30\ndevice: phone\nink: attachments/ink.json'),
    fm('id: a3\nmode: work\nday: 2026-02-28\ndevice: tablet\nink: ../x.json'),
    fm('id: a4\nink: attachments/a/b.json\nday: " 2026-01-05 "'),
    fm('id: "  spaced  "\ncreated: 2026-01-01\nupdated: 5'),
    fm('id: 7\nextraKey: hello\nnested:\n  a: [1, 2]\n  b: { c: "d" }\naiTags: [회의, 일정]\naiEvents: []'),
    fm('id: t1\ntables:\n  - cols: [120, 0, 200]\n    rows: [0, 48]\n    accent: true\n  - {}\n  - merges: [[1, 0, 2, 1], [0, 0, 1, 1], [0, 0, -1, 2]]\n  - {}\n  - {}'),
    fm('id: t2\ntables:\n  - cols: [5, 99999, "40", x]\n  - rows: [0, 0]'),
    fm('id: r1\nreminders:\n  - id: ra\n    kind: at\n    at: 2026-10-01T09:00:00+09:00\n    end: 2026-10-01T10:00:00+09:00\n    created: 2026-09-01T00:00:00+09:00\n    title: "  회의   준비  "\n    alerts: [10, 10, 30, -5, 2.6]\n    action: open'),
    fm('id: r2\nreminders:\n  - id: rb\n    kind: repeat\n    created: 2026-09-01T00:00:00+09:00\n    repeat:\n      every: week\n      time: "7:5"\n      weekdays: [3, 1, 1, 9]\n      interval: 2\n      from: 2026-09-07\n  - id: rc\n    kind: repeat\n    created: 2026-09-02T00:00:00+09:00\n    repeat: { every: month, day: 40 }\n  - id: rd\n    kind: repeat\n    created: 2026-09-03T00:00:00+09:00\n    repeat: { every: year, month: 0, day: 0, time: bad }'),
    fm('id: r3\nreminders:\n  - id: re\n    kind: timer\n    at: 2026-10-01T09:00:00+09:00\n    minutes: 0\n    created: 2026-09-01T00:00:00+09:00\n    enabled: false\n    last: nope\n  - id: rf\n    kind: at\n    created: 2026-09-01T00:00:00+09:00\n  - kind: bogus\n  - id: rg\n    kind: at\n    at: 2026-10-02T09:00:00+09:00\n    created: 2026-09-01T00:00:00+09:00\n    task: true\n    done: true\n    allDay: true\n    alerts: [5]'),
    fm('id: r4\nreminders:\n  - id: rh\n    kind: at\n    at: 2026-10-03\n    created: 2026-09-01T00:00:00+09:00\n    allDay: true\n    alerts: [-540, 900, -2000]\n  - id: ri\n    kind: startup\n    created: 2026-09-01T00:00:00+09:00\n    startup: daily'),
    '---\nid: [broken\n---\n# 깨진 머리말',
    '---\n- just\n- a list\n---\n목록 머리말',
    '---\n---\n빈 머리말',
    '---\n\n위는 구분선으로 시작한 글\n\n---\n아래',
    '﻿---\nid: bom\n---\nBOM 이 붙은 파일',
    '---\r\nid: crlf\r\ncolor: blue\r\n---\r\n줄 끝이 CRLF\r\n둘째 줄\r\n',
    '머리말 없는 글\n\n둘째 문단',
    '',
    '   \n\n',
    '---\nid: dup\nid: dup2\n---\n같은 키 두 번',
    '---\nid: trail\n---   \n본문 앞 빈칸',
    '---\nid: "x: y"\ncolor: yellow\nnote: "#태그 같은 값"\n---\n',
    '---\nid: multi\nmemo: |\n  여러 줄\n  값\n---\n본문\n\n\n',
  ];
  // 본문만 — 줄마다 따로 (제목 · 미리보기 규칙을 촘촘히)
  const lines = sample.split('\n').filter((l) => l.trim());
  const bodies = [
    '# 제목\n\n본문 첫 줄\n출처: 어딘가\n$x^2$ 수식',
    '```\n코드만\n```\n\n뒤 글',
    '<!-- 숨은 주석 -->\n보이는 글',
    '- [ ] \n- [x] 끝냄\n  - [ ] 하위',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '![](attachments/x.mp4)\n![소리](attachments/y.m4a)\n[문서](attachments/z.pdf)\n![사진](attachments/p.PNG "album page")\n![](https://e.com/a.png)\n[웹](https://e.com)',
    'github_pat_ABC_def snake_case _강조_ __굵게__ *별* **굵은별** ~~취소~~',
    '줄 끝 역슬래시\\\n다음',
    '&#x20;&nbsp;앞 띄움 &amp; &lt;b&gt;',
    '<https://naver.com> 와 <a@b.com>',
    '---\nid: x\n---\n깨진 머리말이 본문에 남은 경우',
    '***\n구분선 뒤 제목',
    'a'.repeat(200),
  ];
  return [...files, ...bodies, ...lines];
}
