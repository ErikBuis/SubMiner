import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEnsureOverlayMpvSubtitlesHiddenHandler,
  createRestoreOverlayMpvSubtitlesHandler,
} from './overlay-mpv-sub-visibility';

type VisibilityState = {
  savedSubVisibility: boolean | null;
  revision: number;
};

function makeEnsure(
  requestProperty: (name: string) => Promise<unknown>,
  isOverlayContentReady?: () => boolean,
) {
  const state: VisibilityState = { savedSubVisibility: null, revision: 0 };
  const hidden: boolean[] = [];
  const warnings: string[] = [];
  const ensureHidden = createEnsureOverlayMpvSubtitlesHiddenHandler({
    getMpvClient: () => ({ connected: true, requestProperty }),
    getSavedSubVisibility: () => state.savedSubVisibility,
    setSavedSubVisibility: (visible) => {
      state.savedSubVisibility = visible;
    },
    getRevision: () => state.revision,
    setRevision: (revision) => {
      state.revision = revision;
    },
    setMpvSubVisibility: (visible) => {
      hidden.push(visible);
    },
    isOverlayContentReady,
    logWarn: (message) => warnings.push(message),
  });
  return { ensureHidden, state, hidden, warnings };
}

function makeRestore(initial: {
  saved: boolean | null;
  revision: number;
  connected: boolean;
  keepSuppressed: boolean;
  overlayReady?: boolean;
}) {
  const state: VisibilityState = {
    savedSubVisibility: initial.saved,
    revision: initial.revision,
  };
  const calls: boolean[] = [];
  const restore = createRestoreOverlayMpvSubtitlesHandler({
    getSavedSubVisibility: () => state.savedSubVisibility,
    setSavedSubVisibility: (visible) => {
      state.savedSubVisibility = visible;
    },
    getRevision: () => state.revision,
    setRevision: (revision) => {
      state.revision = revision;
    },
    isMpvConnected: () => initial.connected,
    shouldKeepSuppressedFromVisibleOverlayBinding: () => initial.keepSuppressed,
    setMpvSubVisibility: (visible) => {
      calls.push(visible);
    },
    isOverlayContentReady:
      initial.overlayReady === undefined ? undefined : () => initial.overlayReady === true,
  });
  return { restore, state, calls };
}

test('ensure overlay mpv subtitle suppression captures previous visibility then hides subtitles', async () => {
  const { ensureHidden, state, hidden } = makeEnsure(async () => 'no');

  await ensureHidden();

  assert.equal(state.savedSubVisibility, false);
  assert.equal(state.revision, 1);
  assert.deepEqual(hidden, [false]);
});

// mpv reports sub-visibility as strings, booleans or numbers depending on the path.
const CAPTURED_VISIBILITY_CASES: Array<[unknown, boolean]> = [
  ['no', false],
  ['false', false],
  ['0', false],
  [false, false],
  [0, false],
  ['yes', true],
  [true, true],
  [1, true],
  ['unrecognized', true],
];

for (const [reported, expected] of CAPTURED_VISIBILITY_CASES) {
  test(`ensure captures sub-visibility ${JSON.stringify(reported)} as ${expected}`, async () => {
    const { ensureHidden, state } = makeEnsure(async () => reported);

    await ensureHidden();

    assert.equal(state.savedSubVisibility, expected);
  });
}

test('ensure falls back to visible restore and logs when the visibility read fails', async () => {
  const { ensureHidden, state, hidden, warnings } = makeEnsure(async () => {
    throw new Error('mpv gone');
  });

  await ensureHidden();

  assert.equal(state.savedSubVisibility, true);
  assert.deepEqual(hidden, [false]);
  assert.equal(warnings.length, 1);
});

test('ensure keeps mpv subtitles visible until the overlay content is ready', async () => {
  let ready = false;
  const { ensureHidden, state, hidden } = makeEnsure(
    async () => 'yes',
    () => ready,
  );

  await ensureHidden();
  ready = true;
  await ensureHidden();

  assert.equal(state.savedSubVisibility, true);
  assert.deepEqual(hidden, [true, false]);
});

test('overlapping ensure calls while the overlay loads keep the original hidden visibility', async () => {
  // mpv answers property reads in order with its current value, after earlier writes.
  let mpvSubVisible = false;
  const writes: boolean[] = [];
  const state: VisibilityState = { savedSubVisibility: null, revision: 0 };
  const ensure = createEnsureOverlayMpvSubtitlesHiddenHandler({
    getMpvClient: () => ({
      connected: true,
      requestProperty: () => Promise.resolve(mpvSubVisible ? 'yes' : 'no'),
    }),
    getSavedSubVisibility: () => state.savedSubVisibility,
    setSavedSubVisibility: (visible) => {
      state.savedSubVisibility = visible;
    },
    getRevision: () => state.revision,
    setRevision: (revision) => {
      state.revision = revision;
    },
    setMpvSubVisibility: (visible) => {
      mpvSubVisible = visible;
      writes.push(visible);
    },
    isOverlayContentReady: () => false,
    logWarn: () => {},
  });

  await Promise.all([ensure(), ensure()]);

  assert.equal(state.savedSubVisibility, false);
  assert.deepEqual(writes, [true]);
  assert.equal(mpvSubVisible, true);
});

test('ensure restores the visibility the plugin saved before its loading fallback', async () => {
  const { ensureHidden, state } = makeEnsure(async (name) =>
    name === 'sub-visibility' ? 'yes' : false,
  );

  await ensureHidden();

  assert.equal(state.savedSubVisibility, false);
});

test('overlapping ensure calls that hide share the capture of the visible subtitles', async () => {
  let mpvSubVisible = true;
  const state: VisibilityState = { savedSubVisibility: null, revision: 0 };
  const ensure = createEnsureOverlayMpvSubtitlesHiddenHandler({
    getMpvClient: () => ({
      connected: true,
      requestProperty: (name) =>
        Promise.resolve(name === 'sub-visibility' ? (mpvSubVisible ? 'yes' : 'no') : null),
    }),
    getSavedSubVisibility: () => state.savedSubVisibility,
    setSavedSubVisibility: (visible) => {
      state.savedSubVisibility = visible;
    },
    getRevision: () => state.revision,
    setRevision: (revision) => {
      state.revision = revision;
    },
    setMpvSubVisibility: (visible) => {
      mpvSubVisible = visible;
    },
    logWarn: () => {},
  });

  await Promise.all([ensure(), ensure()]);

  assert.equal(state.savedSubVisibility, true);
  assert.equal(mpvSubVisible, false);
});

test('ensure drops a captured visibility when a newer toggle superseded it', async () => {
  let resolveVisibility!: (value: unknown) => void;
  const { ensureHidden, state } = makeEnsure((name) =>
    name === 'sub-visibility'
      ? new Promise((resolve) => {
          resolveVisibility = resolve;
        })
      : Promise.reject(new Error('property unavailable')),
  );

  const pending = ensureHidden();
  state.revision += 1;
  resolveVisibility('no');
  await pending;

  assert.equal(state.savedSubVisibility, null);
});

const RESTORE_CASES: Array<{
  name: string;
  initial: Parameters<typeof makeRestore>[0];
  force?: boolean;
  expected: { saved: boolean | null; revision: number; calls: boolean[] };
}> = [
  {
    name: 'restore overlay mpv subtitle suppression restores saved visibility',
    initial: { saved: false, revision: 4, connected: true, keepSuppressed: false },
    expected: { saved: null, revision: 5, calls: [false] },
  },
  {
    name: 'restore keeps mpv subtitles hidden when visible-overlay binding still requires suppression',
    initial: { saved: true, revision: 9, connected: true, keepSuppressed: true },
    expected: { saved: true, revision: 9, calls: [false] },
  },
  {
    name: 'restore keeps mpv subtitles visible while the visible overlay is still loading',
    initial: {
      saved: true,
      revision: 9,
      connected: true,
      keepSuppressed: true,
      overlayReady: false,
    },
    expected: { saved: true, revision: 9, calls: [true] },
  },
  {
    name: 'restore leaves mpv subtitles alone while loading when their visibility is not captured yet',
    initial: {
      saved: null,
      revision: 3,
      connected: true,
      keepSuppressed: true,
      overlayReady: false,
    },
    expected: { saved: null, revision: 3, calls: [] },
  },
  {
    name: 'forced restore ignores visible-overlay suppression during app shutdown',
    initial: { saved: true, revision: 9, connected: true, keepSuppressed: true },
    force: true,
    expected: { saved: null, revision: 10, calls: [true] },
  },
  {
    name: 'restore defers mpv subtitle restore while mpv is disconnected',
    initial: { saved: true, revision: 2, connected: false, keepSuppressed: false },
    expected: { saved: true, revision: 3, calls: [] },
  },
];

test('restore tells the plugin once it applied the saved visibility', () => {
  let restoredNotices = 0;
  const calls: boolean[] = [];
  let saved: boolean | null = false;
  const restore = createRestoreOverlayMpvSubtitlesHandler({
    getSavedSubVisibility: () => saved,
    setSavedSubVisibility: (visible) => {
      saved = visible;
    },
    getRevision: () => 0,
    setRevision: () => {},
    isMpvConnected: () => true,
    shouldKeepSuppressedFromVisibleOverlayBinding: () => true,
    setMpvSubVisibility: (visible) => calls.push(visible),
    onSubVisibilityRestored: () => {
      restoredNotices += 1;
    },
  });

  restore();
  assert.equal(restoredNotices, 0);
  restore({ force: true });

  assert.deepEqual(calls, [false, false]);
  assert.equal(restoredNotices, 1);
});

test('quitting before the capture finished still ends the plugin fallback', () => {
  let restoredNotices = 0;
  const restore = createRestoreOverlayMpvSubtitlesHandler({
    getSavedSubVisibility: () => null,
    setSavedSubVisibility: () => {},
    getRevision: () => 0,
    setRevision: () => {},
    isMpvConnected: () => true,
    shouldKeepSuppressedFromVisibleOverlayBinding: () => true,
    setMpvSubVisibility: () => {},
    onSubVisibilityRestored: () => {
      restoredNotices += 1;
    },
  });

  restore();
  assert.equal(restoredNotices, 0);
  restore({ force: true });
  assert.equal(restoredNotices, 1);
});

for (const c of RESTORE_CASES) {
  test(c.name, () => {
    const { restore, state, calls } = makeRestore(c.initial);

    restore(c.force ? { force: true } : undefined);

    assert.equal(state.savedSubVisibility, c.expected.saved);
    assert.equal(state.revision, c.expected.revision);
    assert.deepEqual(calls, c.expected.calls);
  });
}
