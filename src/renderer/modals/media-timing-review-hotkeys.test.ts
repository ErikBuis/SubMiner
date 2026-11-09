import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MEDIA_TIMING_REVIEW_BUTTON_HOTKEYS,
  applyMediaTimingReviewHotkeyTooltips,
  formatMediaTimingReviewHotkeyTooltip,
} from './media-timing-review-hotkeys';
import type { RendererDom } from '../utils/dom';

test('every review hotkey tooltip belongs to a real button without a fixed title', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8');
  for (const domId of Object.keys(MEDIA_TIMING_REVIEW_BUTTON_HOTKEYS)) {
    const match = html.match(new RegExp(`<button\\s+id="${domId}"[^>]*>`));
    assert.ok(match, `missing <button id="${domId}">`);
    // The tooltip comes from the hotkey map, so the markup must not set its own.
    assert.doesNotMatch(match[0], /\stitle=/, `<button id="${domId}"> sets its own title`);
  }
});

test('review hotkey tooltips name the action and its keys', () => {
  assert.equal(
    formatMediaTimingReviewHotkeyTooltip({ action: 'Add the next line', keys: 'N' }),
    'Add the next line (N)',
  );

  const buttons = new Map<string, { title: string }>();
  const dom = new Proxy({} as RendererDom, {
    get(_target, key: string) {
      if (!buttons.has(key)) buttons.set(key, { title: 'fixed title' });
      return buttons.get(key);
    },
  });
  applyMediaTimingReviewHotkeyTooltips(dom);

  for (const [domId, hotkey] of Object.entries(MEDIA_TIMING_REVIEW_BUTTON_HOTKEYS)) {
    assert.equal(buttons.get(domId)?.title, formatMediaTimingReviewHotkeyTooltip(hotkey!));
  }
  // Buttons without a shortcut are not touched.
  assert.equal(buttons.has('mediaTimingReviewResetAll'), false);
  assert.equal(buttons.has('mediaTimingReviewDiscard'), false);
});
