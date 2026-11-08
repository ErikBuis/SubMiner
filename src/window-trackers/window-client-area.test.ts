import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientAreaBounds } from './window-client-area';

const frame = { x: 100, y: 50, width: 1282, height: 752 };

test('client area of a windowed mpv leaves out the title bar and borders', () => {
  assert.deepEqual(resolveClientAreaBounds(frame, { x: 101, y: 82, width: 1280, height: 719 }), {
    x: 101,
    y: 82,
    width: 1280,
    height: 719,
  });
});

test('client area that fills the frame is reported as no separate client area', () => {
  assert.equal(resolveClientAreaBounds(frame, { ...frame }), null);
});

test('client area is clamped to the frame', () => {
  assert.deepEqual(resolveClientAreaBounds(frame, { x: 90, y: 82, width: 1400, height: 800 }), {
    x: 100,
    y: 82,
    width: 1282,
    height: 720,
  });
});

test('missing, empty or disjoint client areas fall back to the frame', () => {
  assert.equal(resolveClientAreaBounds(frame, null), null);
  assert.equal(resolveClientAreaBounds(frame, { x: 101, y: 82, width: 0, height: 719 }), null);
  assert.equal(resolveClientAreaBounds(frame, { x: 5000, y: 82, width: 100, height: 100 }), null);
  assert.equal(
    resolveClientAreaBounds(frame, { x: Number.NaN, y: 82, width: 100, height: 100 }),
    null,
  );
});
