import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCards } from '../extension/src/tab-cards.js';

test('card reconciliation preserves unchanged nodes/canvases and updates only changed cards', () => {
  const container = { children: [], insertBefore(node, before) {
    node.remove(); const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, node);
  } };
  const cards = new Map(); const updated = [];
  const create = tab => ({ id: tab.id, canvas: {}, remove() { const i = container.children.indexOf(this); if (i >= 0) container.children.splice(i, 1); } });
  const update = (node, tab) => updated.push(tab.id);
  const render = tabs => reconcileCards(container, cards, tabs, create, update);
  render([{ id: 1, title: 'one' }, { id: 2, title: 'two' }]);
  const first = cards.get(1).node, second = cards.get(2).node;
  updated.length = 0;
  render([{ id: 1, title: 'one' }, { id: 2, title: 'new title' }]);
  assert.deepEqual(updated, [2]);
  assert.equal(cards.get(1).node, first); assert.equal(cards.get(2).node, second);
  render([{ id: 2, title: 'new title' }, { id: 1, title: 'one' }]);
  assert.deepEqual(container.children, [second, first]);
  render([{ id: 1, title: 'one' }]);
  assert.deepEqual(container.children, [first]); assert.equal(cards.has(2), false);
});
