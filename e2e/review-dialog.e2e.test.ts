import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { connectCdpPage, listCdpTargets, type CdpPage } from './harness/cdp';
import { FIXTURE_CUES } from './harness/fixtures';
import { OVERLAY_PAGE, startE2eSession, type E2eSession } from './harness/session';
import { waitUntil } from './harness/wait';

// Bun caps node:test hooks at 5s whatever their timeout option says, so the
// session boots inside whichever test runs first and every test budgets for it.
const TEST_TIMEOUT_MS = 120_000;
let started: Promise<E2eSession> | undefined;

function useSession(): Promise<E2eSession> {
  started ??= (async () => {
    const session = await startE2eSession({
      config: { ankiConnect: { media: { reviewTiming: true } } },
    });
    try {
      // Mining before the overlay shows a line would race the app's startup.
      const overlay = await session.openPage(OVERLAY_PAGE);
      try {
        await session.mpv.command('seek', FIXTURE_CUES[1].at, 'absolute+exact');
        await overlay.waitFor<boolean>(
          `document.getElementById('subtitleRoot').textContent === ${JSON.stringify(FIXTURE_CUES[1].text)}`,
          { description: 'the overlay to show the line to mine' },
        );
      } finally {
        overlay.close();
      }
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  })();
  return started;
}

after(async () => {
  const running = await started?.catch(() => undefined);
  await running?.dispose();
});

const REVIEW_OPEN = `(() => {
  const modal = document.getElementById('mediaTimingReviewModal');
  return Boolean(modal && !modal.classList.contains('hidden'));
})()`;

// The review opens in the dedicated modal window when the app has one, else in the overlay.
async function findOpenReview(session: E2eSession): Promise<CdpPage | null> {
  const targets = (await listCdpTargets(session.cdpPort)).filter((target) =>
    target.url.includes('renderer/index.html'),
  );
  for (const target of targets) {
    const page = await connectCdpPage(target);
    if (await page.evaluate<boolean>(REVIEW_OPEN).catch(() => false)) return page;
    page.close();
  }
  return null;
}

test(
  'the media timing review keeps mpv paused and exports the reviewed sentence card',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const session = await useSession();
    const cue = FIXTURE_CUES[1];
    await session.mpv.command('seek', cue.at, 'absolute+exact');
    await session.mpv.command('set_property', 'pause', true);
    session.anki.requests.length = 0;

    // The command returns once the card is made, which waits for the review.
    const mining = session.runAppCommand('--mine-sentence');
    const review = await waitUntil(() => findOpenReview(session), {
      description: 'the media timing review to open',
      timeoutMs: 30_000,
    });
    try {
      assert.equal(
        await review.evaluate<string>(
          `document.getElementById('mediaTimingReviewText').textContent.trim()`,
        ),
        cue.text,
      );
      assert.equal(await session.mpv.command('get_property', 'pause'), true);

      // A key that reaches mpv itself (Space after alt+tab back to the player) resumes it
      // behind the dialog; the review pauses it again.
      await session.mpv.command('set_property', 'pause', false);
      await waitUntil(async () => (await session.mpv.command('get_property', 'pause')) === true, {
        description: 'the review to pause mpv again',
        timeoutMs: 5_000,
      });

      await review.evaluate(`document.getElementById('mediaTimingReviewConfirm').click()`);
      const added = await waitUntil(
        () => session.anki.requests.find((request) => request.action === 'addNote'),
        { description: 'the reviewed sentence card to reach Anki', timeoutMs: 30_000 },
      );
      assert.partialDeepStrictEqual(added.params.note, { fields: { Sentence: cue.text } });
      await mining;
      // The window that showed the review may be hidden or gone now, so look afresh.
      assert.equal(await findOpenReview(session), null);
      // Paused before mining, so it stays paused after the review.
      assert.equal(await session.mpv.command('get_property', 'pause'), true);
    } finally {
      review.close();
    }
  },
);
