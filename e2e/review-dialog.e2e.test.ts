import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { connectCdpPage, listCdpTargets, type CdpPage } from './harness/cdp';
import { FIXTURE_CUES } from './harness/fixtures';
import { OVERLAY_PAGE, startE2eSession, type E2eSession } from './harness/session';
import { waitUntil } from './harness/wait';

// Bun caps node:test hooks at 5s whatever their timeout option says, so the
// session boots inside whichever test runs first and every test budgets for it.
const TEST_TIMEOUT_MS = 180_000;
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

// The sentence the review shows, without any furigana readings drawn over it.
const REVIEW_SENTENCE_TEXT = `(() => {
  const sentence = document.getElementById('mediaTimingReviewText').cloneNode(true);
  sentence.querySelectorAll('rt, rp').forEach((reading) => reading.remove());
  return sentence.textContent.trim();
})()`;

// The review opens in the dedicated modal window when the app has one, else in the overlay.
/** What each renderer page shows, for a failure message. */
async function describeRendererPages(session: E2eSession): Promise<string> {
  const lines: string[] = [];
  for (const target of await listCdpTargets(session.cdpPort).catch(() => [])) {
    if (!target.url.includes('renderer/index.html')) continue;
    const page = await connectCdpPage(target).catch(() => null);
    const modalClass = await page
      ?.evaluate<string>(
        `document.getElementById('mediaTimingReviewModal')?.className ?? '(no review modal)'`,
      )
      .catch((error: unknown) => `(evaluate failed: ${String(error)})`);
    page?.close();
    lines.push(`${target.url}: ${modalClass ?? '(could not connect)'}`);
  }
  return lines.join('\n') || '(no renderer pages)';
}

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

// mpv's own bindings for each of these change playback or a setting (--no-config keeps the
// defaults). The test presses them over IPC, which mpv handles exactly like keys pressed in its
// window, for example after alt+tab back to the player while the dialog is open.
const MPV_KEYS = [
  'SPACE', // cycle pause
  'p', // cycle pause
  'RIGHT', // seek 5
  '9', // add volume -2
  'm', // cycle mute
  'z', // add sub-delay -0.1
  'x', // add sub-delay +0.1
  'j', // cycle sub
  '[', // multiply speed 1/1.1
  's', // screenshot
  'q', // quit
  'MBTN_RIGHT', // cycle pause
  'WHEEL_UP', // add volume 2
];

const WATCHED_PROPERTIES = ['pause', 'time-pos', 'volume', 'mute', 'sub-delay', 'sid', 'speed'];

async function mpvState(session: E2eSession): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = {};
  for (const name of WATCHED_PROPERTIES) {
    state[name] = await session.mpv.command('get_property', name);
  }
  return state;
}

async function pressMpvKeys(session: E2eSession, keys: readonly string[]): Promise<void> {
  for (const key of keys) await session.mpv.command('keypress', key);
  // keypress returns once the key is queued; give mpv time to run whatever it is bound to.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

// The app ignores a mining command while it is still adding media to the previous card (it
// only shows "Anki update already in progress" on the OSD), and on slower runners that update
// outlasts the mining command. So before mining, wait for the last card's media update.
async function waitForPreviousCardMedia(session: E2eSession): Promise<void> {
  const requests = session.anki.requests;
  const lastAdd = requests.map((request) => request.action).lastIndexOf('addNote');
  if (lastAdd < 0) return;
  await waitUntil(
    () =>
      requests
        .slice(lastAdd)
        .some(
          (request) =>
            request.action === 'updateNoteFields' &&
            /\[sound:|<img /.test(JSON.stringify(request.params)),
        ),
    { description: "the previous card's media update", timeoutMs: 30_000 },
  );
}

async function openSentenceReview(
  session: E2eSession,
): Promise<{ review: CdpPage; mining: Promise<void> }> {
  await waitForPreviousCardMedia(session);
  const leftOver = await findOpenReview(session);
  if (leftOver) {
    leftOver.close();
    throw new Error('A media timing review from an earlier step is still open');
  }
  await session.mpv.command('seek', FIXTURE_CUES[1].at, 'absolute+exact');
  await session.mpv.command('set_property', 'pause', true);
  session.anki.requests.length = 0;
  // The command returns once the card is made, which waits for the review. Awaiting it here
  // would wait for a review nobody answers.
  const mining = session.runAppCommand('--mine-sentence');
  // A mining command that fails before the review opens should fail the test with its own
  // error, not with a timeout waiting for the review.
  let miningError: unknown;
  mining.catch((error: unknown) => {
    miningError = error;
  });
  try {
    const review = await waitUntil(
      async () => {
        if (miningError) throw miningError;
        return findOpenReview(session);
      },
      // The first review on a fresh macOS runner can take well over 30 s to show.
      { description: 'the media timing review to open', timeoutMs: 90_000 },
    );
    return { review, mining };
  } catch (error) {
    // CI keeps the logs as an artifact, but the end of the app log in the error is quicker.
    const appLog = path.join(session.root, 'app.log');
    const tail = fs.existsSync(appLog)
      ? fs.readFileSync(appLog, 'utf8').split('\n').slice(-40).join('\n')
      : '(no app log)';
    const pages = await describeRendererPages(session);
    throw new Error(
      `${String(error)}\n--- renderer pages ---\n${pages}\n--- end of app.log ---\n${tail}`,
    );
  }
}

test(
  'mpv keys and mouse buttons do nothing behind the media timing review',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const session = await useSession();
    const cue = FIXTURE_CUES[1];
    const screenshotDir = path.join(session.root, 'screenshots');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await session.mpv.command('set_property', 'screenshot-dir', screenshotDir);
    const { review, mining } = await openSentenceReview(session);
    try {
      assert.equal(await review.evaluate<string>(REVIEW_SENTENCE_TEXT), cue.text);
      const before = await mpvState(session);
      assert.equal(before.pause, true);
      assert.equal(before.sid, 1);

      await pressMpvKeys(session, MPV_KEYS);

      assert.deepEqual(await mpvState(session), before);
      assert.deepEqual(fs.readdirSync(screenshotDir), [], 's must not take a screenshot');
      assert.equal(
        await review.evaluate<boolean>(REVIEW_OPEN),
        true,
        'the review stays open after the keys',
      );

      await review.evaluate(`document.getElementById('mediaTimingReviewConfirm').click()`);
    } finally {
      review.close();
    }
    const added = await waitUntil(
      () => session.anki.requests.find((request) => request.action === 'addNote'),
      { description: 'the reviewed sentence card to reach Anki', timeoutMs: 30_000 },
    );
    assert.partialDeepStrictEqual(added.params.note, { fields: { Sentence: cue.text } });
    await mining;
    // Paused before mining, so it stays paused after the review.
    assert.equal(await session.mpv.command('get_property', 'pause'), true);

    // Once the review closes, mpv's keys work again. A slow runner can take longer than one
    // press allows to run the key, so press until mpv has.
    const volume = (await session.mpv.command('get_property', 'volume')) as number;
    await waitUntil(
      async () => {
        await pressMpvKeys(session, ['9']);
        return ((await session.mpv.command('get_property', 'volume')) as number) < volume;
      },
      { description: '9 to lower the volume after the review', timeoutMs: 10_000 },
    );
  },
);

test(
  'cancelling the media timing review gives mpv its keys back',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const session = await useSession();
    const { review, mining } = await openSentenceReview(session);
    try {
      await pressMpvKeys(session, ['SPACE']);
      assert.equal(await session.mpv.command('get_property', 'pause'), true);
      await review.evaluate(`(() => {
        document.getElementById('mediaTimingReviewCancel').click();
        document.getElementById('mediaTimingReviewDiscard').click();
      })()`);
    } finally {
      review.close();
    }
    await mining;
    assert.equal(
      session.anki.requests.some((request) => request.action === 'addNote'),
      false,
      'a discarded card does not reach Anki',
    );

    await pressMpvKeys(session, ['SPACE']);
    assert.equal(await session.mpv.command('get_property', 'pause'), false);
    await session.mpv.command('set_property', 'pause', true);
  },
);
