import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { connectCdpPage, listCdpTargets, type CdpPage } from './harness/cdp';
import { FIXTURE_CUES } from './harness/fixtures';
import { OVERLAY_PAGE, startE2eSession, type E2eSession } from './harness/session';
import { waitUntil } from './harness/wait';

const TEST_TIMEOUT_MS = 180_000;
let session: E2eSession | undefined;

after(async () => {
  await session?.dispose();
});

const REVIEW_OPEN = `(() => {
  const modal = document.getElementById('mediaTimingReviewModal');
  return Boolean(modal && !modal.classList.contains('hidden'));
})()`;

// The review opens in the dedicated modal window when the app has one, else in the overlay.
async function findOpenReview(running: E2eSession): Promise<CdpPage | null> {
  const targets = (await listCdpTargets(running.cdpPort)).filter((target) =>
    target.url.includes('renderer/index.html'),
  );
  for (const target of targets) {
    const page = await connectCdpPage(target);
    if (await page.evaluate<boolean>(REVIEW_OPEN).catch(() => false)) return page;
    page.close();
  }
  return null;
}

type TextBox = { text: string; left: number; right: number; y: number };

// The sentence box, and the height of its first line of text.
const SENTENCE_TEXT_BOX = `(() => {
  const root = document.getElementById('mediaTimingReviewText');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let first = walker.nextNode();
  while (first && !first.textContent.trim()) first = walker.nextNode();
  if (!first) return null;
  const range = document.createRange();
  range.selectNodeContents(first);
  const line = range.getClientRects()[0];
  const box = root.getBoundingClientRect();
  return { text: root.textContent, left: box.left, right: box.right, y: line.top + line.height / 2 };
})()`;

const SELECTED_TEXT = `window.getSelection().toString()`;

/** Real mouse input through Chromium's input pipeline, so selection works as for a person. */
async function mouse(page: CdpPage, type: string, x: number, y: number, buttons: number) {
  await page.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons,
    clickCount: 1,
  });
}

async function drag(page: CdpPage, fromX: number, toX: number, y: number): Promise<void> {
  await mouse(page, 'mouseMoved', fromX, y, 0);
  await mouse(page, 'mousePressed', fromX, y, 1);
  for (let step = 1; step <= 8; step++) {
    await mouse(page, 'mouseMoved', fromX + ((toX - fromX) * step) / 8, y, 1);
  }
  await mouse(page, 'mouseReleased', toX, y, 0);
}

async function click(page: CdpPage, x: number, y: number): Promise<void> {
  await mouse(page, 'mouseMoved', x, y, 0);
  await mouse(page, 'mousePressed', x, y, 1);
  await mouse(page, 'mouseReleased', x, y, 0);
}

test(
  'the mouse selects and deselects text in the media timing review',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    session = await startE2eSession({
      config: { ankiConnect: { media: { reviewTiming: true } } },
    });
    const running = session;
    // Mining before the overlay shows a line would race the app's startup.
    const overlay = await running.openPage(OVERLAY_PAGE);
    try {
      await running.mpv.command('seek', FIXTURE_CUES[1].at, 'absolute+exact');
      await overlay.waitFor<boolean>(
        `document.getElementById('subtitleRoot').textContent === ${JSON.stringify(FIXTURE_CUES[1].text)}`,
        { description: 'the overlay to show the line to mine' },
      );
    } finally {
      overlay.close();
    }
    await running.mpv.command('set_property', 'pause', true);
    // The command returns once the card is made, which waits for the review.
    const mining = running.runAppCommand('--mine-sentence');
    let miningError: unknown;
    mining.catch((error: unknown) => {
      miningError = error;
    });
    const review = await waitUntil(
      async () => {
        if (miningError) throw miningError;
        return findOpenReview(running);
      },
      { description: 'the media timing review to open', timeoutMs: 90_000 },
    );
    try {
      // The dialog puts focus on one of its controls when it opens. A press on plain text
      // used to move focus out of the dialog, and the focus guard pulled it back mid-press,
      // which cancelled the selection.
      await review.waitFor<boolean>(
        `document.getElementById('mediaTimingReviewModal').contains(document.activeElement)`,
        { description: 'the review to focus one of its controls' },
      );
      // The dialog slides in, and a drag measured mid-animation would miss the text.
      await review.waitFor<boolean>(
        `document.querySelector('.media-timing-review-content').getAnimations().every((animation) => animation.playState !== 'running')`,
        { description: 'the review to finish its opening animation' },
      );
      const box = await review.waitFor<TextBox | null>(SENTENCE_TEXT_BOX, {
        description: 'the review to show the sentence',
      });

      // Across the whole first line, from the box's left edge to its right edge.
      await drag(review, box.left + 2, box.right - 2, box.y);
      const selected = (await review.evaluate<string>(SELECTED_TEXT)).trim();
      assert.ok(
        selected.length >= 3 && box.text.includes(selected),
        `selected ${JSON.stringify(selected)} from ${JSON.stringify(box.text)}`,
      );
      assert.equal(
        await review.evaluate<boolean>(
          `document.getElementById('mediaTimingReviewModal').contains(document.activeElement)`,
        ),
        true,
        'focus stays inside the review',
      );

      // A plain click clears the selection again, as it does anywhere else.
      await click(review, (box.left + box.right) / 2, box.y);
      assert.equal(await review.evaluate<string>(SELECTED_TEXT), '');

      // Select-all followed by a click clears too.
      await review.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: 2,
        commands: ['selectAll'],
      });
      await review.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
      assert.notEqual(await review.evaluate<string>(SELECTED_TEXT), '');
      await click(review, (box.left + box.right) / 2, box.y);
      assert.equal(await review.evaluate<string>(SELECTED_TEXT), '');

      await review.evaluate(`(() => {
        document.getElementById('mediaTimingReviewCancel').click();
        document.getElementById('mediaTimingReviewDiscard').click();
      })()`);
    } finally {
      review.close();
    }
    await mining;
  },
);
