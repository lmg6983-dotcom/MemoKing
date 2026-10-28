import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {
  innerHeight: 800,
  innerWidth: 600,
  dispatchEvent: () => {},
  getComputedStyle: () => ({ overflowY: 'visible', listStyle: '' }),
};
try {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
} catch {}

class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.id = '';
    this.className = '';
    this.style = {
      cssText: '',
      removeProperty: () => {},
      setProperty: () => {},
    };
    this.attributes = {};
    this.childNodes = [];
    this._listeners = {};
    this.offsetWidth = 150;
    this.offsetHeight = 32;
  }
  setAttribute(name, val) { this.attributes[name] = val; }
  getAttribute(name) { return this.attributes[name]; }
  get firstChild() { return this.childNodes[0] || null; }
  set textContent(val) {
    this.childNodes = [{ textContent: val }];
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent || '').join('');
  }
  set innerHTML(html) {
    if (html.includes('<span></span>')) {
      const span = new MockElement('span');
      const btn = new MockElement('button');
      btn.className = 'mk-undo-btn';
      btn.textContent = '되돌리기';
      const kbd = new MockElement('kbd');
      kbd.textContent = 'Ctrl+Z';
      this.childNodes = [span, btn, kbd];
    }
  }
  querySelector(sel) {
    if (sel === '.mk-undo-btn') return this.childNodes.find((c) => c.className === 'mk-undo-btn') || null;
    return null;
  }
  addEventListener(type, fn) {
    (this._listeners[type] ??= []).push(fn);
  }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
  }
  dispatchEvent(ev) {
    (this._listeners[ev.type] || []).forEach((fn) => fn(ev));
  }
  getBoundingClientRect() {
    return { top: 760, bottom: 796, height: 36, left: 0, right: 600, width: 600 };
  }
  remove() {
    if (globalThis.document.body.children) {
      globalThis.document.body.children = globalThis.document.body.children.filter((c) => c !== this);
    }
  }
  get classList() {
    return {
      add: (cls) => { this.className += ` ${cls}`; },
      remove: (cls) => { this.className = this.className.replace(cls, '').trim(); },
    };
  }
}

const bodyEl = new MockElement('body');
bodyEl.children = [];
bodyEl.append = (el) => bodyEl.children.push(el);

const mockDoc = {
  styleSheets: [],
  head: new MockElement('head'),
  documentElement: new MockElement('html'),
  body: bodyEl,
  createElement: (tag) => new MockElement(tag),
  getElementById: (id) => bodyEl.children.find((c) => c.id === id) || null,
  querySelector: (sel) => {
    return mockDoc.querySelectorAll(sel)[0] || null;
  },
  querySelectorAll: (sel) => {
    const list = [];
    if (sel.includes('.format-bar') && mockDoc._hasFormatBar !== false) {
      const fb = new MockElement('div');
      fb.className = 'format-bar';
      fb.getBoundingClientRect = () => ({ top: 760, bottom: 796, height: 36, left: 0, right: 600, width: 600 });
      list.push(fb);
    }
    if (sel.includes('.tag-suggest-bar') && mockDoc._hasTagSuggestBar) {
      const tb = new MockElement('div');
      tb.className = 'tag-suggest-bar';
      // 추천 태그 바가 서식 막대보다 더 위(예: top 720)에 위치할 때
      tb.getBoundingClientRect = () => ({ top: 720, bottom: 756, height: 36, left: 0, right: 600, width: 600 });
      list.push(tb);
    }
    return list;
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = mockDoc;

globalThis.KeyboardEvent = class {
  constructor(type, init) {
    this.type = type;
    Object.assign(this, init);
  }
};

const editorEl = new MockElement('main');
editorEl.id = 'editor';
editorEl.parentElement = bodyEl;
bodyEl.children.push(editorEl);
bodyEl.insertBefore = (node, ref) => {
  const idx = ref ? bodyEl.children.indexOf(ref) : -1;
  if (idx >= 0) bodyEl.children.splice(idx, 0, node);
  else bodyEl.children.push(node);
  node.parentElement = bodyEl;
};
Object.defineProperty(editorEl, 'nextSibling', {
  get() {
    const i = bodyEl.children.indexOf(editorEl);
    return i >= 0 ? bodyEl.children[i + 1] || null : null;
  },
});

const { undoHint } = await import('../app/js/delete-button.js');

test('되돌리기 안내: 메모 수정영역(#editor) 바깥에 배치되어 편집 영역을 가리지 않는다', () => {
  let dispatchedKey = null;
  const mockView = {
    isDestroyed: false,
    focus: () => {},
    dom: {
      dispatchEvent: (ev) => { dispatchedKey = ev; },
    },
  };

  undoHint('표', { top: 100, left: 150, width: 200, height: 100 }, mockView);

  const tip = document.getElementById('mk-undo-hint');
  assert.ok(tip, '되돌리기 안내 요소가 생성됨');
  assert.ok(tip.className.includes('outside-editor'), '수정영역 바깥 클래스가 부여됨');
  assert.equal(bodyEl.children.indexOf(tip), bodyEl.children.indexOf(editorEl) + 1, '#editor 바로 뒤(바깥)에 배치됨');
  assert.ok(!editorEl.childNodes.includes(tip), '#editor 내부를 가리지 않음');

  // 클릭 후 Ctrl+Z 전달 및 닫힘
  const undoBtn = tip.querySelector('.mk-undo-btn');
  undoBtn.dispatchEvent({ type: 'click' });
  assert.equal(dispatchedKey?.key, 'z');
  assert.equal(document.getElementById('mk-undo-hint'), null);
});
