// 실제 Windows 클립보드로 붙여넣기 점검 (npm run smoke:clipboard)
// 가짜 이벤트가 아니라 시스템 클립보드에 실제 앱들이 넣는 형식 그대로 넣고,
// 메모 창에서 실제 "붙여넣기"(Ctrl+V 와 같은 명령)를 실행한다.
// 점검하는 동안 클립보드가 바뀌므로, 시작 전 내용을 백업했다가 끝나면 되돌린다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 설치판에서는 asar 밖(app.asar.unpacked)에 있다
const HELPER = path.join(import.meta.dirname, '..', 'scripts', 'clipboard-helper.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

export async function runClipboardChecks({
  list, newNote, closeNote, js, until, wait, key, readMemo, check, capture, vaultDir, workDir, iconPng, imageBase, quickMemo, noteWins,
  smokeToasts, ready, getCapturePoint,
}) {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  // 설치판에서는 아이콘이 asar 안에 있어 PowerShell 이 읽지 못하므로 임시 폴더로 꺼내 둔다
  const iconCopy = path.join(workDir, 'icon.png');
  fs.writeFileSync(iconCopy, fs.readFileSync(iconPng));
  iconPng = iconCopy;
  const backupDir = path.join(workDir, 'backup');
  let seq = 0;
  const tmp = (name, content) => {
    const file = path.join(workDir, `${++seq}-${name}`);
    fs.writeFileSync(file, content, 'utf8');
    return file;
  };
  const helper = (action, args = {}) => execFileSync('powershell.exe', [
    '-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Action', action,
    ...Object.entries(args).flatMap(([k, v]) => [`-${k}`, v]),
  ], { encoding: 'utf8' }).trim();

  // 실제 앱들이 클립보드에 넣는 모양
  const clip = {
    text: (text) => helper('text', { TextFile: tmp('text.txt', text) }),
    html: (html, text, image) => helper('html', {
      HtmlFile: tmp('frag.html', html),
      ...(text ? { TextFile: tmp('text.txt', text) } : {}),
      ...(image ? { ImageFile: image } : {}),
    }),
    image: (image) => helper('image', { ImageFile: image }),
    files: (files) => helper('files', { ListFile: tmp('files.txt', files.join('\r\n')) }),
  };

  const attachmentsDir = path.join(vaultDir, 'attachments');
  const countAttachments = () => fs.readdirSync(attachmentsDir).length;

  const backup = helper('backup', { Dir: backupDir });
  try {
    const { id, win } = await newNote(() => js(list, `document.getElementById('new-btn').click()`));
    win.webContents.insertText('붙여넣기 점검');
    await wait(100);

    // 새 줄에서 실제 붙여넣기 (Ctrl+V 와 같은 Chromium paste 명령)
    async function paste() {
      await key(win, 'End', ['control']);
      await key(win, 'Enter');
      win.focus();
      win.webContents.focus();
      win.webContents.paste();
      await wait(500);
    }
    const saved = (pred, label) => until(() => {
      try {
        return pred(readMemo(id));
      } catch {
        return false;
      }
    }, label, 5000).catch(() => false);
    const r = {};

    // A) 메모장에서 복사한 일반 텍스트
    clip.text('메모장 첫 줄\r\n메모장 둘째 줄');
    await paste();
    r.plain = await saved((md) => md.includes('메모장 첫 줄') && md.includes('메모장 둘째 줄'), '일반 텍스트');

    // B) 마크다운 텍스트 (다른 마크다운 앱·LLM 답변에서 복사)
    clip.text('## 붙인 제목\n\n- 붙인 항목 1\n- 붙인 항목 2\n\n**굵은 붙이기** 와 `코드`');
    await paste();
    r.markdown = await saved((md) => md.includes('## 붙인 제목') && md.includes('- 붙인 항목 2') && md.includes('**굵은 붙이기**'), '마크다운 텍스트');

    // C) 웹페이지·워드에서 복사한 서식 있는 글 (HTML + 텍스트)
    clip.html(
      '<p><b>웹굵게</b> <i>웹기울임</i> <u>웹밑줄</u> <a href="https://example.com/">웹링크</a></p><ul><li>웹목록</li></ul>',
      '웹굵게 웹기울임 웹밑줄 웹링크\r\n웹목록',
    );
    await paste();
    r.html = await saved((md) => md.includes('**웹굵게**') && /[*_]웹기울임[*_]/.test(md) && md.includes('<u>웹밑줄</u>')
      && md.includes('[웹링크](https://example.com/)') && md.includes('- 웹목록'), '서식 있는 글');

    // D) 화면 캡처(Win+Shift+S) — 그림만
    let before = countAttachments();
    clip.image(iconPng);
    await paste();
    r.screenshot = await saved((md) => countAttachments() === before + 1 && /!\[[^\]]*\]\(attachments\/[^)]+\.png\)/.test(md), '화면 캡처');

    // E) 브라우저 "이미지 복사" — 그림 + <img src="https://…"> HTML 이 함께 들어온다
    before = countAttachments();
    clip.html('<img src="https://example.com/cat.png" alt="고양이">', null, iconPng);
    await paste();
    r.webImage = await saved((md) => countAttachments() === before + 1 && !md.includes('https://example.com/cat.png'), '웹 이미지 복사');
    r.webImageDetail = readMemo(id).includes('https://example.com/cat.png')
      ? `인터넷 주소로만 들어감 (폴더에 저장 안 됨, 첨부 +${countAttachments() - before})` : `첨부 +${countAttachments() - before}`;

    // F) 탐색기에서 파일 복사(Ctrl+C) — PDF · 텍스트 · 그림
    const files = [path.join(workDir, '분기 보고서.pdf'), path.join(workDir, '회의 메모.txt'), path.join(workDir, '사진.png')];
    fs.writeFileSync(files[0], '%PDF-1.4\n% 메모킹 점검용\n');
    fs.writeFileSync(files[1], '탐색기에서 복사한 텍스트 파일');
    fs.copyFileSync(iconPng, files[2]);
    before = countAttachments();
    clip.files(files);
    await paste();
    r.explorer = await saved((md) => countAttachments() === before + 3
      && md.includes('[분기 보고서.pdf](attachments/') && md.includes('[회의 메모.txt](attachments/') && /!\[사진\]\(attachments\/[^)]+\.png\)/.test(md), '탐색기 파일');
    r.explorerDetail = `첨부 +${countAttachments() - before}`;

    // G) 워드·엑셀처럼 "글 + 그 글을 찍은 그림"이 함께 들어온 경우 — 글이 붙고 그림 파일은 생기면 안 됨
    before = countAttachments();
    clip.html('<p>워드에서 복사한 문단</p>', '워드에서 복사한 문단', iconPng);
    await paste();
    r.office = (await saved((md) => md.includes('워드에서 복사한 문단'), '워드 문단')) && countAttachments() === before;
    r.officeDetail = `첨부 +${countAttachments() - before}`;

    // H) 웹페이지에서 글과 사진을 함께 선택해 복사 → 글은 서식대로, 사진은 메모 폴더에 받아 저장 (v0.7.0)
    before = countAttachments();
    clip.html(`<p>웹 글과 사진</p><p><img src="${imageBase}/cat.png?clip=1" alt="웹 사진"></p>`, '웹 글과 사진');
    await paste();
    r.webMixed = await saved((md) => md.includes('웹 글과 사진') && /!\[웹 사진\]\(attachments\//.test(md) && countAttachments() === before + 1, '웹 글+사진');

    // 체크리스트로 끝나는 메모: 편집기가 끝에 붙이는 빈 줄이 파일에 <br /> 로 남지 않아야 함
    await key(win, 'End', ['control']);
    await key(win, 'Enter');
    await key(win, '9', ['control', 'shift']);
    win.webContents.insertText('마지막 할 일');
    await wait(100);

    await capture(win, 'smoke-clipboard.png');
    await closeNote(id);
    const finalMd = readMemo(id);
    check('[파일] 목록으로 끝나는 메모 끝에 <br /> 가 붙지 않음', /- \[ \] 마지막 할 일\n$/.test(finalMd), JSON.stringify(finalMd.slice(-40)));

    check('[클립보드] 메모장 텍스트', r.plain);
    check('[클립보드] 마크다운 텍스트 → 서식으로', r.markdown);
    check('[클립보드] 웹·워드 서식 있는 글 → 굵게·기울임·밑줄·링크·목록 유지', r.html);
    check('[클립보드] 화면 캡처 그림 → attachments 에 저장', r.screenshot);
    check('[클립보드] 브라우저 "이미지 복사" → attachments 에 저장', r.webImage, r.webImageDetail);
    check('[클립보드] 탐색기에서 복사한 파일 3개 → 파일 칩·이미지', r.explorer, r.explorerDetail);
    check('[클립보드] 워드처럼 글+그림 → 글만 붙음', r.office, r.officeDetail);
    check('[클립보드] 웹 글+사진 → 사진도 메모 폴더에 저장', r.webMixed);

    // ---------- 빠른 메모 (Ctrl+Alt+C) ----------
    const quick = async (options) => newNote(() => quickMemo(options));
    const mdWhen = (id, pred, label) => until(() => {
      try {
        return pred(readMemo(id));
      } catch {
        return false;
      }
    }, label, 6000).catch(() => false);

    // Q1) 웹 글+사진 → 서식대로, 사진은 폴더에, 끝에 출처
    clip.html(`<h2>빠른 메모 기사</h2><p>본문 <b>굵게</b></p><p><img src="${imageBase}/cat.png?quick=1" alt="사진"></p>`, '빠른 메모 기사 본문 굵게');
    const q1 = await quick({ copy: false });
    const q1ok = await mdWhen(q1.id, (md) => md.includes('## 빠른 메모 기사') && md.includes('**굵게**')
      && /!\[사진\]\(attachments\//.test(md) && /> 출처: .*\(Ctrl\+Alt\+C\)/.test(md), '빠른 메모: 웹 글');
    check('[빠른 메모] 웹 글+사진 → 새 메모 (서식·사진 저장·출처)', q1ok,
      `${JSON.stringify(readMemo(q1.id)).slice(0, 600)} | 상태: ${await js(q1.win, `document.getElementById('status').textContent`)}`);
    const cursor = getCapturePoint(); // 메모를 만든 순간의 마우스 위치 (그 뒤에 사용자가 움직여도 무관)
    const b = q1.win.getBounds();
    check('[빠른 메모] 마우스 위치 근처에 뜬다', Math.abs(b.x - (cursor.x - 48)) < 400 && Math.abs(b.y - (cursor.y - 18)) < 400, JSON.stringify({ b, cursor }));
    await capture(q1.win, 'smoke-quick-memo.png');

    // v0.8.1: 다른 창에 묻히지 않게 — 포커스는 뺏지 않고 잠깐 맨 위 + Windows 알림, 누르면 그 메모로
    const peekNow = q1.win.isAlwaysOnTop();
    const t1 = smokeToasts.find((t) => t.kind === 'quick-memo' && t.memoId === q1.id);
    check('[빠른 메모] Windows 알림 (제목 · 메모 제목 · 누르면 이동 안내)',
      t1 && t1.title === '메모를 만들었어요' && /빠른 메모 기사/.test(t1.body) && /누르면 메모로 가요/.test(t1.body), JSON.stringify(t1));
    await wait(3000);
    check('[빠른 메모] 새 메모가 잠깐 맨 위에 보였다가 원래대로', peekNow && !q1.win.isAlwaysOnTop());
    await closeNote(q1.id);
    t1?.onClick();
    const back = await until(() => noteWins.get(q1.id), '알림 눌러 메모 열기').catch(() => null);
    if (back) await ready(back);
    const flashed = back ? await until(() => js(back, `document.body.classList.contains('highlight')`), '반짝임', 3000).catch(() => false) : false;
    check('[빠른 메모] 알림을 누르면 (닫은 메모도) 다시 열려 앞으로 오고 반짝임', Boolean(back) && back.isVisible() && flashed);
    if (back) await closeNote(q1.id);

    // Q2) 탐색기에서 복사한 파일들
    clip.files([files[0], files[2]]);
    const q2 = await quick({ copy: false });
    const q2ok = await mdWhen(q2.id, (md) => md.includes('# 분기 보고서.pdf 외 1개') && md.includes('[분기 보고서.pdf](attachments/')
      && /!\[사진\]\(attachments\//.test(md), '빠른 메모: 파일');
    check('[빠른 메모] 탐색기 파일 → 파일 칩·그림, 제목은 파일 이름', q2ok, readMemo(q2.id).split('---').pop().slice(0, 300));
    await closeNote(q2.id);

    // Q3) 화면 캡처 그림
    clip.image(iconPng);
    const q3 = await quick({ copy: false });
    const q3ok = await mdWhen(q3.id, (md) => md.includes('# 캡처한 그림') && /!\[캡처한 그림\]\(attachments\/[^)]+\.png\)/.test(md), '빠른 메모: 그림');
    check('[빠른 메모] 캡처 그림 → 그림 메모', q3ok);
    await closeNote(q3.id);

    // Q4) 실제 복사: 메모 창에서 글을 선택해 두고 빠른 메모 → 도우미가 앞 창에 Ctrl+C 를 보내 복사
    clip.text('이전 클립보드 내용');
    const src = await newNote(() => js(list, `document.getElementById('new-btn').click()`));
    src.win.webContents.insertText('선택해서 빠른 메모로 보낼 글');
    await wait(200);
    src.win.focus();
    src.win.webContents.focus();
    await key(src.win, 'A', ['control']);
    await wait(200);
    // 실제 Ctrl+C 는 "지금 맨 앞의 창" 으로 간다. 사용자가 다른 앱에서 작업 중이면 그 앱에 키가 가므로,
    // 메모킹 창이 실제로 맨 앞일 때만 확인하고 아니면 건너뛴다.
    // 도우미가 키를 보내기 직전에 Windows 의 맨 앞 창이 이 점검 프로세스인지 확인한다 (아니면 보내지 않음)
    const before4 = new Set(noteWins.keys());
    const made = await quickMemo({ copy: true, onlyPid: process.pid });
    if (!made) {
      check('[빠른 메모] 선택한 글을 Ctrl+C 로 복사해 메모로 (실제 키 보내기) — 건너뜀: 다른 앱이 맨 앞에 있어 키를 보내지 않음', true);
    } else {
      const q4id = [...noteWins.keys()].find((k) => !before4.has(k));
      const q4ok = q4id && await mdWhen(q4id, (md) => md.includes('선택해서 빠른 메모로 보낼 글'), '빠른 메모: 실제 복사');
      check('[빠른 메모] 선택한 글을 Ctrl+C 로 복사해 메모로 (실제 키 보내기)', q4ok,
        q4id ? readMemo(q4id).split('---').pop().slice(0, 200) : '새 메모가 열리지 않음');
      if (q4id) await closeNote(q4id);
    }
    await closeNote(src.id);
    return readMemo(id);
  } finally {
    const restored = helper('restore', { Dir: backupDir });
    console.log(`  (클립보드 원래 내용 되돌림: 백업 ${backup} → 복원 ${restored})`);
  }
}
