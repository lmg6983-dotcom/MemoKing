// 파일 끌어 놓기 (PC 메모 창): 창 어디에 놓아도 받고, 끄는 동안 놓을 수 있는 곳 · 놓일 자리를 보인다
//   예전: 받는 곳이 편집기의 글자 줄(contenteditable)뿐이었다 — 짧은 메모는 창의 약 20%. 글 아래 빈 곳 · 여백 · 머리줄에
//   놓으면 브라우저가 "놓을 수 없음" 으로 처리해 아무 일도 없었고, 다시 글 위에 놓아야 들어갔다 (한 번에 안 먹히던 까닭)
//   표시: 창 가장자리를 따라 흐르는 점선(놓을 수 있는 곳) + 놓일 줄을 따라다니는 삽입선(점 달린 가로줄) + 무엇을 하는지 한 줄
//   (PM 의 drop 보다 먼저 창에서 받아 한 길로 넣는다 — 편집기 안의 Milkdown 업로드도 같은 insertFilesAt)

const hasFiles = (dt) => [...(dt?.types ?? [])].includes('Files');
const HIDE_MS = 220; // 끄는 동안 dragover 는 가만히 있어도 50ms 마다 온다 — 이만큼 끊기면 창 밖으로 나간 것

/**
 * @param {{ dropAt: (x: number, y: number) => ({ pos: number, line: { top: number, left: number, width: number } } | null),
 *           onDrop: (pos: number, files: File[]) => void, isOwn?: (dt: DataTransfer) => boolean }} o
 *   dropAt: 넣을 수 없으면(편집기 전 · 잠긴 메모 · 읽기 전용) null
 */
export function setupFileDrop({ dropAt, onDrop, isOwn = () => false, trace = () => {} }) {
  // 진단 (memoking.log 의 [끌기]): 끌기 한 번마다 — 창이 열린 지 몇 초 · dragover 수 · 놓기가 왔는지 · 넣을 자리가 있었는지
  //   사용자 보고 "새 창은 첫 끌어 놓기를 무시" 를 실제 PC 에서 잡으려고 (CI 의 OLE 재현에서는 되지 않았다)
  const opened = performance.now();
  let session = null;
  const sec = () => ((performance.now() - opened) / 1000).toFixed(1);
  const zone = document.createElement('div');
  zone.className = 'mk-dropzone';
  zone.hidden = true;
  zone.setAttribute('aria-hidden', 'true');
  const pill = document.createElement('div');
  pill.className = 'mk-drop-pill';
  zone.append(pill);
  const line = document.createElement('div');
  line.className = 'mk-dropline';
  line.hidden = true;
  line.setAttribute('aria-hidden', 'true');
  document.body.append(zone, line);

  let hideTimer = 0;
  let raf = 0;
  let last = null; // 마지막 dragover 자리 (그리기는 화면 주기에 한 번)
  const hide = () => {
    if (session && !session.dropped) trace(`끌기 끝 (놓지 않음 · 창 연 지 ${sec()}초 · dragover ${session.overs}번 · 넣을 자리 ${session.ok ? '있음' : '없음'})`);
    session = null;
    clearTimeout(hideTimer);
    cancelAnimationFrame(raf);
    raf = 0;
    zone.hidden = true;
    line.hidden = true;
    document.body.classList.remove('mk-file-dragging');
  };
  const paint = () => {
    raf = 0;
    if (!last) return;
    const at = dropAt(last.x, last.y);
    zone.classList.toggle('no', !at);
    pill.textContent = at ? `${last.count > 1 ? `파일 ${last.count}개를 ` : ''}놓으면 이 줄에 넣어요` : '여기에는 넣을 수 없어요';
    line.hidden = !at;
    if (at) {
      const top = Math.min(Math.max(at.line.top, 4), innerHeight - 4);
      line.style.transform = `translate(${Math.round(at.line.left)}px, ${Math.round(top - 1.5)}px)`;
      line.style.width = `${Math.max(24, Math.round(at.line.width))}px`;
    }
  };

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault(); // 창 어디서든 놓을 수 있게 (안 하면 글자 줄 밖은 "놓을 수 없음")
    const ok = Boolean(dropAt(e.clientX, e.clientY));
    e.dataTransfer.dropEffect = ok ? 'copy' : 'none';
    session ??= { overs: 0, ok: false, dropped: false };
    session.overs++;
    session.ok = ok;
    last = { x: e.clientX, y: e.clientY, count: e.dataTransfer.items?.length ?? 0 };
    if (zone.hidden) {
      zone.hidden = false;
      document.body.classList.add('mk-file-dragging');
    }
    raf ||= requestAnimationFrame(paint);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_MS);
  }, true);
  window.addEventListener('dragenter', (e) => {
    if (hasFiles(e.dataTransfer)) e.preventDefault();
  }, true);
  window.addEventListener('dragend', hide, true);
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    // 편집기(ProseMirror · 업로드 플러그인)보다 먼저 받아 한 번만 넣는다
    e.preventDefault();
    e.stopPropagation();
    if (session) session.dropped = true;
    const overs = session?.overs ?? 0;
    hide();
    const dt = e.dataTransfer;
    trace(`놓기 받음 (창 연 지 ${sec()}초 · dragover ${overs}번 · 파일 ${dt.files.length}개 · 자리 ${dropAt(e.clientX, e.clientY) ? '있음' : '없음'}${isOwn(dt) ? ' · 이 메모에서 끌어낸 것' : ''})`);
    if (isOwn(dt)) return; // 이 메모에서 끌어낸 파일이 도로 떨어졌다
    const at = dropAt(e.clientX, e.clientY);
    if (!at) return;
    // 폴더는 빼고 (폴더는 webkitGetAsEntry 로만 알 수 있다 — 놓는 그 순간에만 읽힌다)
    const entries = [...dt.items].map((it) => it.webkitGetAsEntry?.());
    const files = [...dt.files].filter((_f, i) => !entries[i]?.isDirectory);
    onDrop(at.pos, files); // 비었으면(폴더만) 부르는 쪽이 알린다
  }, true);
  return { hide };
}
