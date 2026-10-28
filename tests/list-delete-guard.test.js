import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleListDelete } from '../app/js/list-delete-guard.js';

function createMockView({
  inListItem = true,
  parentOffset = 0,
  empty = true,
  contentSize = 3,
  nodeAfter = { isText: true, text: 'abc', nodeSize: 3 },
  pos = 10,
} = {}) {
  let dispatchedTr = null;

  const mockState = {
    selection: {
      empty,
      $from: {
        pos,
        parentOffset,
        parent: {
          content: { size: contentSize },
        },
        depth: 2,
        node(d) {
          if (inListItem && d === 1) return { type: { name: 'list_item' } };
          if (d === 2) return { type: { name: 'paragraph' } };
          return { type: { name: 'doc' } };
        },
        nodeAfter,
      },
    },
    tr: {
      delete(from, to) {
        this.deletedRange = { from, to };
        return this;
      },
      scrollIntoView() {
        return this;
      },
    },
  };

  const mockView = {
    state: mockState,
    dispatch(tr) {
      dispatchedTr = tr;
    },
  };

  return { mockView, getDispatchedTr: () => dispatchedTr };
}

test('목록 Delete 방어: Delete 키가 아니거나 수정 키가 있으면 무시한다', () => {
  const { mockView, getDispatchedTr } = createMockView();

  assert.equal(handleListDelete(mockView, { key: 'Backspace' }), false);
  assert.equal(handleListDelete(mockView, { key: 'Enter' }), false);
  assert.equal(handleListDelete(mockView, { key: 'Delete', ctrlKey: true }), false);
  assert.equal(handleListDelete(mockView, { key: 'Delete', shiftKey: true }), false);
  assert.equal(handleListDelete(mockView, { key: 'Delete', altKey: true }), false);
  assert.equal(getDispatchedTr(), null);
});

test('목록 Delete 방어: 선택 영역이 있거나 맨 앞이 아니거나 list_item이 아니면 무시한다', () => {
  // 1. 선택 영역이 있는 경우
  const selView = createMockView({ empty: false });
  assert.equal(handleListDelete(selView.mockView, { key: 'Delete' }), false);

  // 2. parentOffset > 0 (글자 중간/끝)
  const offsetView = createMockView({ parentOffset: 2 });
  assert.equal(handleListDelete(offsetView.mockView, { key: 'Delete' }), false);

  // 3. list_item 외부 (일반 문단)
  const nonListView = createMockView({ inListItem: false });
  assert.equal(handleListDelete(nonListView.mockView, { key: 'Delete' }), false);
});

test('목록 Delete 방어: 글자가 있을 때 다음 한 글자만 지우고 이벤트를 가로챈다', () => {
  const { mockView, getDispatchedTr } = createMockView({
    inListItem: true,
    parentOffset: 0,
    contentSize: 3,
    nodeAfter: { isText: true, text: '가나다', nodeSize: 3 },
    pos: 10,
  });

  const handled = handleListDelete(mockView, { key: 'Delete' });
  assert.equal(handled, true);
  const tr = getDispatchedTr();
  assert.ok(tr);
  assert.deepEqual(tr.deletedRange, { from: 10, to: 11 });
});

test('목록 Delete 방어: 이모지(서러게이트 페어)가 올 때 2글자 단위로 지운다', () => {
  const emojiText = '😀웃음';
  const { mockView, getDispatchedTr } = createMockView({
    inListItem: true,
    parentOffset: 0,
    contentSize: emojiText.length,
    nodeAfter: { isText: true, text: emojiText, nodeSize: emojiText.length },
    pos: 15,
  });

  const handled = handleListDelete(mockView, { key: 'Delete' });
  assert.equal(handled, true);
  const tr = getDispatchedTr();
  assert.ok(tr);
  assert.deepEqual(tr.deletedRange, { from: 15, to: 17 });
});

test('목록 Delete 방어: 인라인 아톰 노드가 올 때 해당 nodeSize 만큼 지운다', () => {
  const { mockView, getDispatchedTr } = createMockView({
    inListItem: true,
    parentOffset: 0,
    contentSize: 1,
    nodeAfter: { isText: false, nodeSize: 1 },
    pos: 20,
  });

  const handled = handleListDelete(mockView, { key: 'Delete' });
  assert.equal(handled, true);
  const tr = getDispatchedTr();
  assert.ok(tr);
  assert.deepEqual(tr.deletedRange, { from: 20, to: 21 });
});

test('목록 Delete 방어 [선택 B]: 빈 목록 항목에서는 목록 서식이 풀리지 않도록 완전 보호(no-op)한다', () => {
  const { mockView, getDispatchedTr } = createMockView({
    inListItem: true,
    parentOffset: 0,
    contentSize: 0, // 빈 내용
    nodeAfter: null,
    pos: 5,
  });

  const handled = handleListDelete(mockView, { key: 'Delete' });
  assert.equal(handled, true, 'Milkdown의 LiftFirstListItem 호출을 막기 위해 true 반환');
  assert.equal(getDispatchedTr(), null, '아무것도 지우거나 변경하지 않음 (목록 유지)');
});
