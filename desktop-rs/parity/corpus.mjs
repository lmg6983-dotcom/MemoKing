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
    // 자르는 자리에 그림 글자(UTF-16 둘)가 걸린 제목 · 미리보기 — 반쪽을 남기지 않는다 (JS cut16 · Rust slice16)
    `# ${'가'.repeat(79)}😀 끝\n${'나'.repeat(1199)}😀 끝`,
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
    '#태그 #업무 #1 #_ #a-b- #c__ (#괄호) "#따옴표" **#굵게** a#낱말 https://a.com/#x `#코드` <span style="color: #e03131">빨강</span> \\#이스케이프 #Tag #tag',
    '    #들여쓴코드\n\t#탭코드\n~~~\n#울타리\n~~~\n#밖 ①#동그라미 ١٢#숫자',
    '- [ ] 하나\n* [x] 둘\n+ [X] 셋\n1. [ ] 넷\n2) [x] 다섯\n-[ ] 아님\n- [ ]아님\n```\n- [ ] 코드\n~~~\n- [ ] 아직 코드\n```\n- [x] 밖',
    '# 비밀\n\n🔒 잠긴 메모예요. 메모킹에서 비밀번호를 넣으면 열려요.\n\n<!-- memoking-lock v1 n=310000 s=AAAA i=BBBB c=CCCC== -->\n',
    '<!-- memoking-lock v1 n=310000 s=AAAA i=BBBB c=CCCC== -->',
    '앞에 글\n<!-- memoking-lock v1 n=310000 s=AAAA i=BBBB c=CCCC== -->',
    '![a](attachments/%ED%95%9C.png) ![b](attachments/%E0%A4%A.png) ![c]( <attachments/sp ace.jpg> ) ![d](attachments/q.webm "x") ![동영상](attachments/v.webm) ![t](attachments/t.png "pdf attachments/doc.pdf") [x](memo.md) [y](attachments/f.zip)',
  ];
  return [...files, ...bodies, ...lines];
}

// 색인(index.json)에 넣는 메모 묶음들 — [이름, { id, file, text }[]] (id · 파일 이름을 정해 두어 늘 같은 색인)
export function indexSets() {
  const head = (id, extra) => `---\nid: ${id}\ncreated: 2026-09-01T09:00:00+09:00\nupdated: 2026-09-02T10:30:00+09:00\n${extra}---\n`;
  const linked = [
    ['회의록.md', 'm1', 'color: green\npinned: true\nlinks: [m2, m3, m1, gone]\n', '# 주간 회의록\n\n위원회의 결정과 부서회의 안건을 정리했다. 고양이를 키우는 직원이 사무실에서 일정을 공유했다.\n\n## 안건\n- 예산 검토 #회의 #업무\n- 견적서 보내기\n\n## 다음 일정 ##\n\n![화이트보드](attachments/board.png)\n[회의 자료](attachments/slides.pdf)'],
    ['업무/견적.md', 'm2', 'links: [m1]\n', '# 견적서 정리\n\n거래처에 견적서를 보냈다. 예산과 일정은 회의록에 있다. The quick brown fox and the lazy dog.\n\n```\n# 코드 안 제목은 소제목이 아님\n```'],
    ['업무/출장.md', 'm3', '', '# 부산 출장\n\n부산으로 기차를 타고 출장을 간다. 숙소는 호텔, 일정은 회의 뒤에.\n\n| 날짜 | 할 일 |\n| --- | --- |\n| 월 | 회의 |'],
    ['Travel.md', 'm4', 'color: blue\n', `# Travel plan\n\n${'Jeju island trip with family and friends, beach and hiking. '.repeat(5)}\n\n둘째 문단`],
    ['apple.md', 'm5', 'links: [m4]\n', '# 하와이 여행\n\n소아과 진료 뒤 미술가 친구와 하와이로 간다. 사과와 바나나를 샀다. 2026 년 12 월.'],
    ['가계부.md', 'm6', '', `# 가계부\n\n${'가'.repeat(230)}\n\n월세 관리비 보험`],
    ['가계부 (사본).md', 'm7', 'links: [m6]\n', '# 가계부\n\n월세 · 관리비 · 보험 · 적금 · 대출 이자를 정리했다.\n\n짧은 줄\n\n또 다른 줄'],
    ['빈 메모.md', 'm8', '', ''],
    ['_memo.md', 'm9', '', '中國 漢字 메모 中文 ㄱㄴ 1번 abc ABC Abc café cafe'],
  ].map(([file, id, extra, body]) => ({ id, file, text: `${head(id, extra)}${body}` }));

  // 모두 같은 글이면 점수가 같다 — 같은 점수는 파일 이름 순
  const same = ['b.md', 'A.md', 'a.md', '가.md', '1.md', 'ㄴ.md', 'a b.md', 'a_b.md', 'a(1).md', 'a.b.md'].map((file, i) => ({ id: `s${i}`, file, text: '# 같은 글\n\n사과 바나나 포도 수박' }));

  // fixtures 의 모든 글 — 파일 이름은 차례 번호 (제목에서 만들면 같은 이름이 생긴다), 넷 중 하나는 폴더 안
  const all = corpus().map((text, i) => ({ id: `c${i}`, file: `${i % 4 ? '' : '폴더/'}글 ${i}.md`, text }));
  return [['empty', []], ['linked', linked], ['same', same], ['corpus', all]];
}
