import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const css = readFileSync(resolve(__dirname, 'style.css'), 'utf8');

// Every rule for the selector, including ones inside @media blocks.
function ruleBodies(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[}\\s,])${escaped}\\s*\\{([^}]*)\\}`, 'g');
  return [...css.matchAll(pattern)].map((match) => match[1] ?? '');
}

// The card review scrolls as a whole; none of its fields may become a small scrolling box.
for (const selector of [
  '.media-timing-review-word',
  '.media-timing-review-meaning',
  '.media-timing-review-text',
  '.media-timing-review-translation-input',
]) {
  test(`card review field ${selector} grows with its text instead of scrolling`, () => {
    const bodies = ruleBodies(selector);
    assert.ok(bodies.length > 0, `expected a rule for ${selector}`);
    for (const body of bodies) {
      assert.doesNotMatch(body, /(?:^|[\s;])max-height\s*:/, `${selector} must not cap its height`);
      assert.doesNotMatch(
        body,
        /(?:^|[\s;])overflow(?:-y)?\s*:\s*(?:auto|scroll)/,
        `${selector} must not scroll on its own`,
      );
    }
  });
}

test('the card review dialog itself still scrolls when its content is taller than the window', () => {
  const [body] = ruleBodies('.media-timing-review-content');
  assert.ok(body);
  assert.match(body, /max-height\s*:/);
  assert.match(body, /overflow\s*:\s*auto/);
});
