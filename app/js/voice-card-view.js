// 음성 카드 보기 (편집기 플러그인, 데스크탑·휴대폰 함께) — core/voice-card.js 의 인용을 카드로
//   - 소리 플레이어와 받아쓴 글이 한 칸에. 아래 막대로 접기·펴기 (접으면 첫 문장만 흐리게 미리 보기) · 그 옆 복사(받아쓴 글만)
//   - 길면(8줄 넘게) 처음엔 접힌 채로, 접기 상태는 소리 파일마다 기억
//   - 말한 사람마다 색: "화자 1:" 이름표와 왼쪽 줄 색 (이어 말한 줄도 같은 색)
//   - 카드는 한 줄(블록)이라 소리 이름 줄이나 받아쓴 글을 꾹 눌러 옮기면 받아쓴 글도 함께 움직인다
//   - 커서가 접힌 곳으로 들어가면 저절로 펼친다
import { Plugin, PluginKey, Decoration, DecorationSet } from '../vendor/milkdown.js';
import { SPEAKER_LINE } from './core/voice-card.js';
import { haptic } from './dom.js';
import { copyText } from './copy-content.js';
import { COPY_ICON, DONE_ICON } from './content-icons.js';

export const voiceCardKey = new PluginKey('memoking-voice-card');
const FOLD_KEY = 'memoking.voiceFold';
const AUTO_FOLD = 8;
const SPEAKER_COLORS = 6;

// 음성 카드인지 보기는 편집기 없이도 쓰도록 core/voice-card.js 에 (목록 창이 편집기 라이브러리를 읽지 않게)
import { voiceAudioOf, isVoiceCard } from './core/voice-card.js';
export { voiceAudioOf, isVoiceCard } from './core/voice-card.js';

function speakerOf(paragraph) {
  const first = paragraph?.firstChild;
  if (!first?.isText || !first.marks.some((m) => m.type.name === 'strong')) return 0;
  const m = first.text.trim().match(/^화자\s*(\d+)\s*[:：]?$/) ?? first.text.match(SPEAKER_LINE);
  return m ? Number(m[1]) : 0;
}

/** 카드 안 받아쓴 글 요약: 줄 수, 말한 사람 수, 첫 문장 */
export function voiceSummary(node) {
  const speakers = new Set();
  let first = '';
  let lines = 0;
  node.forEach((child, _, i) => {
    if (i === 0) return;
    const text = child.textContent.trim();
    if (!text) return;
    lines++;
    const s = speakerOf(child);
    if (s) speakers.add(s);
    if (!first) first = text.replace(SPEAKER_LINE, '').replace(/[.。…!?]+$/, '');
  });
  return { lines, speakers: speakers.size, first };
}

function readFolds() {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function saveFold(src, folded) {
  try {
    const all = readFolds();
    all[src] = folded;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete all[k]; // 오래된 것부터 정리
    localStorage.setItem(FOLD_KEY, JSON.stringify(all));
  } catch {
    // 이번에만
  }
}

/** 받아쓴 글만 (소리 이름 줄 빼고, 줄마다 한 줄 — "화자 1: …" 이름표는 그대로) */
function transcriptText(node) {
  const lines = [];
  node.forEach((c, _, i) => {
    if (i > 0 && c.type.name === 'paragraph' && c.textContent.trim()) lines.push(c.textContent.trim());
  });
  return lines.join('\n');
}

function plainQuote() {
  const dom = document.createElement('blockquote');
  return { dom, contentDOM: dom, update: (n) => n.type.name === 'blockquote' && !isVoiceCard(n) };
}

function voiceView(node) {
  const src = voiceAudioOf(node).attrs.src;
  const dom = document.createElement('div');
  dom.className = 'mk-voice';
  const body = document.createElement('div');
  body.className = 'mk-voice-body';
  const bar = document.createElement('div');
  bar.className = 'mk-voice-bar';
  bar.contentEditable = 'false';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'mk-voice-toggle';
  const chev = document.createElement('span');
  chev.className = 'mk-voice-chev';
  chev.textContent = '▾';
  const label = document.createElement('span');
  label.className = 'mk-voice-label';
  const peek = document.createElement('span');
  peek.className = 'mk-voice-peek';
  toggle.append(chev, label, peek);
  // 받아쓴 글 복사 — 접기 옆 (접혀 있어도). 누르면 잠깐 ✓
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'mk-voice-copy';
  copy.title = '받아쓴 글 복사';
  copy.setAttribute('aria-label', '받아쓴 글 복사');
  const copyIco = document.createElement('span');
  copyIco.className = 'mk-voice-copy-ico';
  copyIco.innerHTML = COPY_ICON;
  const copyLabel = document.createElement('span');
  copyLabel.textContent = '복사';
  copy.append(copyIco, copyLabel);
  bar.append(toggle, copy);
  dom.append(body, bar);

  let current = node;
  let summary = voiceSummary(node);
  const stored = readFolds()[src];
  let folded = stored ?? summary.lines > AUTO_FOLD;

  function render() {
    const { lines, speakers, first } = summary;
    bar.hidden = lines === 0;
    dom.classList.toggle('folded', folded && lines > 0);
    dom.classList.toggle('has-text', lines > 0);
    const who = speakers >= 2 ? `, 화자 ${speakers}명` : '';
    label.textContent = folded ? `받아쓰기 ${lines}줄${who}` : `접기${who}`;
    peek.textContent = folded && first ? first : '';
    toggle.setAttribute('aria-expanded', String(!folded));
  }
  function setFolded(next, remember = true) {
    if (next === folded) return;
    folded = next;
    if (remember) saveFold(src, folded);
    dom.classList.add('mk-voice-anim');
    setTimeout(() => dom.classList.remove('mk-voice-anim'), 260);
    render();
  }
  // 누르는 동안 커서·키보드가 움직이지 않게 (손가락이 닿는 것은 편집기도 받아, 꾹 누르면 카드를 옮긴다)
  toggle.addEventListener('mousedown', (e) => e.preventDefault());
  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    haptic(8);
    setFolded(!folded);
  });
  copy.addEventListener('mousedown', (e) => e.preventDefault());
  let copyTimer = 0;
  copy.addEventListener('click', async (e) => {
    e.preventDefault();
    haptic(8);
    let ok = true;
    try {
      await copyText({ text: transcriptText(current) });
    } catch {
      ok = false;
    }
    copyIco.innerHTML = ok ? DONE_ICON : COPY_ICON;
    copyLabel.textContent = ok ? '복사했어요' : '복사하지 못했어요';
    copy.classList.toggle('done', ok);
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyIco.innerHTML = COPY_ICON;
      copyLabel.textContent = '복사';
      copy.classList.remove('done');
    }, 1500);
  });
  dom.mkUnfold = () => setFolded(false, false);
  render();

  return {
    dom,
    contentDOM: body,
    update(next) {
      if (next.type.name !== 'blockquote' || voiceAudioOf(next)?.attrs.src !== src) return false;
      current = next;
      summary = voiceSummary(next);
      render();
      return true;
    },
    stopEvent: (e) => e.type !== 'touchstart' && e.target instanceof Node && bar.contains(e.target),
    ignoreMutation: (m) => bar.contains(m.target) || m.target === dom,
  };
}

// 말한 사람 색: 이름표가 있는 줄과, 그 뒤 이름표 없이 이어지는 줄
function speakerDecorations(doc) {
  const decos = [];
  doc.forEach((card, offset) => {
    if (!isVoiceCard(card)) return;
    let who = 0;
    let pos = offset + 1;
    card.forEach((child, _, i) => {
      if (i > 0 && child.type.name === 'paragraph') {
        const s = speakerOf(child);
        if (s) who = s;
        const cls = ['mk-voice-line'];
        if (who) cls.push(`mk-spk-${(who - 1) % SPEAKER_COLORS}`, s ? 'mk-spk-start' : 'mk-spk-cont');
        decos.push(Decoration.node(pos, pos + child.nodeSize, { class: cls.join(' ') }));
      }
      pos += child.nodeSize;
    });
  });
  return DecorationSet.create(doc, decos);
}

export function createVoiceCards() {
  let cache = { doc: null, set: DecorationSet.empty };
  return new Plugin({
    key: voiceCardKey,
    props: {
      nodeViews: { blockquote: (node) => (isVoiceCard(node) ? voiceView(node) : plainQuote()) },
      decorations(state) {
        if (cache.doc !== state.doc) cache = { doc: state.doc, set: speakerDecorations(state.doc) };
        return cache.set;
      },
    },
    view: () => ({
      update(view, prev) {
        if (prev && prev.selection.eq(view.state.selection)) return;
        const { $from } = view.state.selection;
        if ($from.depth < 1) return;
        const top = $from.node(1);
        if (!isVoiceCard(top) || $from.index(1) === 0) return;
        view.nodeDOM($from.before(1))?.mkUnfold?.();
      },
    }),
  });
}
