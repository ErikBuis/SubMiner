import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModalWindowGeometry } from './modal-window-geometry';

const frame = { x: 100, y: 50, width: 1282, height: 752 };
const content = { x: 101, y: 82, width: 1280, height: 719 };

test('modal window covers only the client area of the tracked mpv window', () => {
  const tracker = { getGeometry: () => frame, getContentGeometry: () => content };
  assert.deepEqual(resolveModalWindowGeometry({ ...frame }, tracker), content);
});

test('modal window keeps the given geometry without a separate client area', () => {
  const tracker = { getGeometry: () => frame, getContentGeometry: () => null };
  assert.deepEqual(resolveModalWindowGeometry(frame, tracker), frame);
  assert.deepEqual(resolveModalWindowGeometry(frame, null), frame);
});

test('modal window keeps geometry that is not the tracked mpv window', () => {
  const tracker = { getGeometry: () => frame, getContentGeometry: () => content };
  const fallback = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(resolveModalWindowGeometry(fallback, tracker), fallback);
  const untracked = { getGeometry: () => null, getContentGeometry: () => content };
  assert.deepEqual(resolveModalWindowGeometry(frame, untracked), frame);
});
