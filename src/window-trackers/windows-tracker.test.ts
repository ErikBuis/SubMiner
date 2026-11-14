import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsWindowTracker } from './windows-tracker';
import type { MpvPollResult } from './win32';

function mpvVisible(
  overrides: Partial<
    MpvPollResult & { x?: number; y?: number; width?: number; height?: number; focused?: boolean }
  > = {},
): MpvPollResult {
  return {
    matches: [
      {
        hwnd: 12345,
        bounds: {
          x: overrides.x ?? 0,
          y: overrides.y ?? 0,
          width: overrides.width ?? 1280,
          height: overrides.height ?? 720,
        },
        area: (overrides.width ?? 1280) * (overrides.height ?? 720),
        isForeground: overrides.focused ?? true,
      },
    ],
    focusState: overrides.focused ?? true,
    windowState: 'visible',
  };
}

const mpvNotFound: MpvPollResult = {
  matches: [],
  focusState: false,
  windowState: 'not-found',
};

const mpvMinimized: MpvPollResult = {
  matches: [],
  focusState: false,
  windowState: 'minimized',
};

test('WindowsWindowTracker skips overlapping polls while poll is in flight', () => {
  let pollCalls = 0;
  let tracker: WindowsWindowTracker;
  tracker = new WindowsWindowTracker(undefined, {
    pollMpvWindows: () => {
      pollCalls += 1;
      if (pollCalls === 1) {
        (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
      }
      return mpvVisible();
    },
  });

  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(pollCalls, 1);
});

test('WindowsWindowTracker updates geometry from poll output', () => {
  const tracker = new WindowsWindowTracker(undefined, {
    pollMpvWindows: () => mpvVisible({ x: 10, y: 20, width: 1280, height: 720 }),
  });

  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();

  assert.deepEqual(tracker.getGeometry(), {
    x: 10,
    y: 20,
    width: 1280,
    height: 720,
  });
  assert.equal(tracker.isTargetWindowFocused(), true);
});

test('WindowsWindowTracker preserves an unfocused initial match', () => {
  const tracker = new WindowsWindowTracker(undefined, {
    pollMpvWindows: () => mpvVisible({ x: 10, y: 20, width: 1280, height: 720, focused: false }),
  });

  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();

  assert.deepEqual(tracker.getGeometry(), {
    x: 10,
    y: 20,
    width: 1280,
    height: 720,
  });
  assert.equal(tracker.isTargetWindowFocused(), false);
});

test('WindowsWindowTracker clears geometry for poll misses', () => {
  const tracker = new WindowsWindowTracker(undefined, {
    pollMpvWindows: () => mpvNotFound,
    trackingLossGraceMs: 0,
  });

  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.getGeometry(), null);
  assert.equal(tracker.isTargetWindowFocused(), false);
});

test('WindowsWindowTracker keeps the last geometry through a single poll miss', () => {
  let callIndex = 0;
  const outputs = [
    mpvVisible({ x: 10, y: 20, width: 1280, height: 720 }),
    mpvNotFound,
    mpvVisible({ x: 10, y: 20, width: 1280, height: 720 }),
  ];

  const tracker = new WindowsWindowTracker(undefined, {
    pollMpvWindows: () => outputs[callIndex++] ?? outputs.at(-1)!,
    trackingLossGraceMs: 0,
  });

  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.deepEqual(tracker.getGeometry(), { x: 10, y: 20, width: 1280, height: 720 });

  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.deepEqual(tracker.getGeometry(), { x: 10, y: 20, width: 1280, height: 720 });

  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.deepEqual(tracker.getGeometry(), { x: 10, y: 20, width: 1280, height: 720 });
});

test('WindowsWindowTracker drops tracking after grace window expires', () => {
  let callIndex = 0;
  let now = 1_000;
  const outputs = [
    mpvVisible({ x: 10, y: 20, width: 1280, height: 720 }),
    mpvNotFound,
    mpvNotFound,
    mpvNotFound,
    mpvNotFound,
  ];

  const tracker = new WindowsWindowTracker(undefined, {
    pollMpvWindows: () => outputs[callIndex++] ?? outputs.at(-1)!,
    now: () => now,
    trackingLossGraceMs: 500,
  });

  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);

  now += 250;
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);

  now += 250;
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);

  now += 250;
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);

  now += 250;
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), false);
  assert.equal(tracker.getGeometry(), null);
});

test('WindowsWindowTracker keeps tracking through repeated poll misses inside grace window', () => {
  let callIndex = 0;
  let now = 1_000;
  const outputs = [
    mpvVisible({ x: 10, y: 20, width: 1280, height: 720 }),
    mpvNotFound,
    mpvNotFound,
    mpvNotFound,
    mpvVisible({ x: 10, y: 20, width: 1280, height: 720 }),
  ];

  const tracker = new WindowsWindowTracker(undefined, {
    pollMpvWindows: () => outputs[callIndex++] ?? outputs.at(-1)!,
    now: () => now,
    trackingLossGraceMs: 1_500,
  });

  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);

  now += 250;
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);

  now += 250;
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);

  now += 250;
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);
  assert.deepEqual(tracker.getGeometry(), { x: 10, y: 20, width: 1280, height: 720 });

  now += 250;
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);
  assert.deepEqual(tracker.getGeometry(), { x: 10, y: 20, width: 1280, height: 720 });
});

test('WindowsWindowTracker keeps tracking through a transient minimized report inside minimized grace window', () => {
  let callIndex = 0;
  let now = 1_000;
  const outputs: MpvPollResult[] = [
    mpvVisible({ x: 10, y: 20, width: 1280, height: 720 }),
    mpvMinimized,
    mpvVisible({ x: 10, y: 20, width: 1280, height: 720 }),
  ];

  const tracker = new WindowsWindowTracker(undefined, {
    pollMpvWindows: () => outputs[callIndex++] ?? outputs.at(-1)!,
    now: () => now,
    minimizedTrackingLossGraceMs: 200,
  });

  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);

  now += 100;
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);
  assert.deepEqual(tracker.getGeometry(), { x: 10, y: 20, width: 1280, height: 720 });

  now += 100;
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);
  assert.deepEqual(tracker.getGeometry(), { x: 10, y: 20, width: 1280, height: 720 });
});

test('WindowsWindowTracker keeps tracking through repeated transient minimized reports inside minimized grace window', () => {
  let callIndex = 0;
  let now = 1_000;
  const outputs: MpvPollResult[] = [
    mpvVisible({ x: 10, y: 20, width: 1280, height: 720 }),
    mpvMinimized,
    mpvMinimized,
    mpvVisible({ x: 10, y: 20, width: 1280, height: 720 }),
  ];

  const tracker = new WindowsWindowTracker(undefined, {
    pollMpvWindows: () => outputs[callIndex++] ?? outputs.at(-1)!,
    now: () => now,
    minimizedTrackingLossGraceMs: 500,
  });

  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);

  now += 250;
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);
  assert.equal(tracker.isTargetWindowMinimized(), true);
  assert.deepEqual(tracker.getGeometry(), { x: 10, y: 20, width: 1280, height: 720 });

  now += 250;
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);
  assert.equal(tracker.isTargetWindowMinimized(), true);
  assert.deepEqual(tracker.getGeometry(), { x: 10, y: 20, width: 1280, height: 720 });

  now += 250;
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
  assert.equal(tracker.isTracking(), true);
  assert.equal(tracker.isTargetWindowMinimized(), false);
  assert.deepEqual(tracker.getGeometry(), { x: 10, y: 20, width: 1280, height: 720 });
});

const SOCKET_PATH = String.raw`\\.\pipe\subminer-socket`;
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

function pollOnce(tracker: WindowsWindowTracker): void {
  (tracker as unknown as { pollGeometry: () => void }).pollGeometry();
}

test('WindowsWindowTracker follows the process that answers on the target socket', async () => {
  const queriedSockets: string[] = [];
  const polledPids: Array<number | null> = [];
  const tracker = new WindowsWindowTracker(SOCKET_PATH, {
    queryMpvProcessId: async (socketPath) => {
      queriedSockets.push(socketPath);
      return 4242;
    },
    pollMpvWindows: (targetPid) => {
      polledPids.push(targetPid);
      return mpvVisible();
    },
  });

  pollOnce(tracker);
  assert.equal(tracker.isTracking(), false);

  await flushPromises();
  pollOnce(tracker);
  assert.equal(tracker.isTracking(), true);
  assert.deepEqual(queriedSockets, [SOCKET_PATH]);
  assert.deepEqual(polledPids, [4242]);
});

test('WindowsWindowTracker keeps polling while a process lookup is pending', async () => {
  let queries = 0;
  let answer: (pid: number) => void = () => {};
  let now = 1_000;
  const tracker = new WindowsWindowTracker(SOCKET_PATH, {
    now: () => now,
    queryMpvProcessId: () => {
      queries += 1;
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
    pollMpvWindows: () => mpvVisible(),
  });

  for (let poll = 0; poll < 120; poll += 1) {
    pollOnce(tracker);
    now += 250;
  }
  assert.equal(tracker.isTracking(), false);
  assert.equal(queries, 1);

  answer(4242);
  await flushPromises();
  pollOnce(tracker);
  assert.equal(tracker.isTracking(), true);
});

test('WindowsWindowTracker retries a failed lookup at a limited rate', async () => {
  let queries = 0;
  let now = 1_000;
  const tracker = new WindowsWindowTracker(SOCKET_PATH, {
    now: () => now,
    queryMpvProcessId: async () => {
      queries += 1;
      if (queries === 1) throw new Error('connect ENOENT');
      return 4242;
    },
    pollMpvWindows: () => mpvVisible(),
  });

  pollOnce(tracker);
  await flushPromises();
  now += 250;
  pollOnce(tracker);
  await flushPromises();
  assert.equal(queries, 1);

  now += 1_000;
  pollOnce(tracker);
  await flushPromises();
  pollOnce(tracker);
  assert.equal(queries, 2);
  assert.equal(tracker.isTracking(), true);
});

test('WindowsWindowTracker moves to the new process when mpv restarts on the same socket', async () => {
  let currentPid = 1111;
  let now = 1_000;
  let queries = 0;
  const polledPids: Array<number | null> = [];
  const tracker = new WindowsWindowTracker(SOCKET_PATH, {
    now: () => now,
    queryMpvProcessId: async () => {
      queries += 1;
      return currentPid;
    },
    // Only the live process still owns a window.
    pollMpvWindows: (targetPid) => {
      polledPids.push(targetPid);
      return targetPid === currentPid ? mpvVisible() : mpvNotFound;
    },
  });

  pollOnce(tracker);
  await flushPromises();
  pollOnce(tracker);
  assert.equal(tracker.isTracking(), true);

  currentPid = 2222;
  now += 2_000;
  pollOnce(tracker);
  await flushPromises();
  pollOnce(tracker);
  assert.equal(tracker.isTracking(), true);
  assert.deepEqual(tracker.getGeometry(), { x: 0, y: 0, width: 1280, height: 720 });
  assert.equal(polledPids.at(-1), 2222);
  assert.equal(queries, 2);
});

test('WindowsWindowTracker revalidates a PID even while its window remains visible', async () => {
  let currentPid = 1111;
  let now = 0;
  const polledPids: Array<number | null> = [];
  const tracker = new WindowsWindowTracker(SOCKET_PATH, {
    now: () => now,
    queryMpvProcessId: async () => currentPid,
    // Simulates PID reuse: the old PID still has a visible, unrelated window.
    pollMpvWindows: (pid) => {
      polledPids.push(pid);
      return mpvVisible();
    },
  });
  pollOnce(tracker);
  await flushPromises();
  pollOnce(tracker);
  currentPid = 2222;
  now = 10_000;
  pollOnce(tracker);
  await flushPromises();
  pollOnce(tracker);
  assert.equal(polledPids.at(-1), 2222);
});

test('WindowsWindowTracker expires an unvalidated PID and recovers after IPC returns', async () => {
  let available = true;
  let now = 0;
  const polledPids: Array<number | null> = [];
  const tracker = new WindowsWindowTracker(SOCKET_PATH, {
    now: () => now,
    queryMpvProcessId: async () => {
      if (!available) throw new Error('IPC unavailable');
      return 4242;
    },
    pollMpvWindows: (pid) => {
      polledPids.push(pid);
      return mpvVisible();
    },
    trackingLossGraceMs: 0,
    maxConsecutiveMisses: 1,
  });
  pollOnce(tracker);
  await flushPromises();
  pollOnce(tracker);
  assert.equal(tracker.isTracking(), true);
  available = false;
  now = 10_000;
  pollOnce(tracker);
  await flushPromises();
  assert.equal(tracker.isTracking(), true);
  polledPids.length = 0;
  now = 30_000;
  pollOnce(tracker);
  await flushPromises();
  assert.equal(tracker.isTracking(), false);
  assert.deepEqual(polledPids, []);
  available = true;
  now += 1_000;
  pollOnce(tracker);
  await flushPromises();
  pollOnce(tracker);
  assert.equal(tracker.isTracking(), true);
  assert.equal(polledPids.at(-1), 4242);
});

function createWatchStub() {
  const watches: Array<{ pid: number; onMove: (hwnd: number) => void; stopped: boolean }> = [];
  return {
    watches,
    watchWindowLocation: (pid: number, onMove: (hwnd: number) => void) => {
      const watch = { pid, onMove, stopped: false };
      watches.push(watch);
      return () => {
        watch.stopped = true;
      };
    },
  };
}

test('WindowsWindowTracker follows mpv window moves between polls', async () => {
  const stub = createWatchStub();
  let now = 1_000;
  let liveBounds = { x: 0, y: 0, width: 1280, height: 720 };
  const geometries: Array<{ x: number; y: number }> = [];
  const tracker = new WindowsWindowTracker(SOCKET_PATH, {
    now: () => now,
    queryMpvProcessId: async () => 4242,
    pollMpvWindows: () => mpvVisible(liveBounds),
    watchWindowLocation: stub.watchWindowLocation,
    readWindowBounds: (hwnd) => (hwnd === 12345 ? liveBounds : null),
  });
  tracker.onGeometryChange = (geometry) => geometries.push({ x: geometry.x, y: geometry.y });

  tracker.start();
  try {
    await flushPromises();
    pollOnce(tracker);
    pollOnce(tracker);
    assert.equal(tracker.isTracking(), true);
    // Repeated polls for the same process keep the one subscription.
    assert.equal(stub.watches.length, 1);
    assert.equal(stub.watches[0]!.pid, 4242);

    // A drag reports many moves before the next poll; each one moves the overlay.
    for (const x of [10, 20, 30]) {
      now += 16;
      liveBounds = { ...liveBounds, x };
      stub.watches[0]!.onMove(12345);
    }
    assert.deepEqual(
      geometries.map((geometry) => geometry.x),
      [0, 10, 20, 30],
    );

    // Moves of other windows are ignored, even when the tracked window has moved meanwhile.
    now += 16;
    liveBounds = { ...liveBounds, x: 40 };
    stub.watches[0]!.onMove(999);
    assert.equal(geometries.length, 4);

    // A minimized or hidden mpv window has no bounds; the poll deals with that.
    now += 16;
    const visibleBounds = liveBounds;
    liveBounds = null as never;
    stub.watches[0]!.onMove(12345);
    assert.equal(geometries.length, 4);
    liveBounds = visibleBounds;
  } finally {
    tracker.stop();
  }
  assert.equal(stub.watches[0]!.stopped, true);
});

test('WindowsWindowTracker moves the overlay at most once per frame during a fast drag', async () => {
  const stub = createWatchStub();
  let now = 1_000;
  let liveBounds = { x: 0, y: 0, width: 1280, height: 720 };
  const geometries: number[] = [];
  const tracker = new WindowsWindowTracker(SOCKET_PATH, {
    now: () => now,
    queryMpvProcessId: async () => 4242,
    pollMpvWindows: () => mpvVisible(liveBounds),
    watchWindowLocation: stub.watchWindowLocation,
    readWindowBounds: () => liveBounds,
  });
  tracker.onGeometryChange = (geometry) => geometries.push(geometry.x);

  tracker.start();
  try {
    await flushPromises();
    pollOnce(tracker);
    for (const x of [1, 2, 3, 4]) {
      now += 1;
      liveBounds = { ...liveBounds, x };
      stub.watches[0]!.onMove(12345);
    }
    // The first move applies right away; the rest wait for the frame to end.
    assert.deepEqual(geometries, [0, 1]);
    now += 8;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The final position is applied once, so the overlay ends where mpv ends.
    assert.deepEqual(geometries, [0, 1, 4]);
  } finally {
    tracker.stop();
  }
});

test('WindowsWindowTracker logs and ignores a failing bounds read', async () => {
  const stub = createWatchStub();
  const tracker = new WindowsWindowTracker(SOCKET_PATH, {
    queryMpvProcessId: async () => 4242,
    pollMpvWindows: () => mpvVisible(),
    watchWindowLocation: stub.watchWindowLocation,
    readWindowBounds: () => {
      throw new Error('window gone');
    },
  });

  tracker.start();
  try {
    await flushPromises();
    pollOnce(tracker);
    assert.doesNotThrow(() => stub.watches[0]!.onMove(12345));
    assert.equal(tracker.getGeometry()?.x, 0);
  } finally {
    tracker.stop();
  }
});

test('WindowsWindowTracker subscribes again after a restart', async () => {
  const stub = createWatchStub();
  const tracker = new WindowsWindowTracker(SOCKET_PATH, {
    queryMpvProcessId: async () => 4242,
    pollMpvWindows: () => mpvVisible(),
    watchWindowLocation: stub.watchWindowLocation,
    readWindowBounds: () => null,
  });

  tracker.start();
  await flushPromises();
  pollOnce(tracker);
  tracker.stop();
  tracker.start();
  pollOnce(tracker);
  tracker.stop();
  assert.deepEqual(
    stub.watches.map((watch) => [watch.pid, watch.stopped]),
    [
      [4242, true],
      [4242, true],
    ],
  );
});

test('WindowsWindowTracker ignores window moves after it stops', async () => {
  const stub = createWatchStub();
  const geometries: number[] = [];
  const tracker = new WindowsWindowTracker(SOCKET_PATH, {
    queryMpvProcessId: async () => 4242,
    pollMpvWindows: () => mpvVisible(),
    watchWindowLocation: stub.watchWindowLocation,
    readWindowBounds: () => ({ x: 50, y: 0, width: 1280, height: 720 }),
  });
  tracker.onGeometryChange = (geometry) => geometries.push(geometry.x);

  tracker.start();
  await flushPromises();
  pollOnce(tracker);
  tracker.stop();
  stub.watches[0]!.onMove(12345);
  assert.deepEqual(geometries, [0]);
});

test('WindowsWindowTracker moves the window watch to a restarted mpv process', async () => {
  const stub = createWatchStub();
  let pid = 4242;
  let now = 1_000;
  const tracker = new WindowsWindowTracker(SOCKET_PATH, {
    now: () => now,
    queryMpvProcessId: async () => pid,
    pollMpvWindows: (targetPid) => (targetPid === pid ? mpvVisible() : mpvNotFound),
    watchWindowLocation: stub.watchWindowLocation,
    readWindowBounds: () => null,
  });

  await flushPromises();
  pollOnce(tracker);
  await flushPromises();
  pollOnce(tracker);
  assert.deepEqual(
    stub.watches.map((watch) => watch.pid),
    [4242],
  );

  pid = 5151;
  now += 1_100;
  pollOnce(tracker);
  await flushPromises();
  pollOnce(tracker);
  assert.deepEqual(
    stub.watches.map((watch) => [watch.pid, watch.stopped]),
    [
      [4242, true],
      [5151, false],
    ],
  );
  tracker.stop();
});

test('WindowsWindowTracker keeps polling when window moves cannot be watched', async () => {
  const tracker = new WindowsWindowTracker(SOCKET_PATH, {
    queryMpvProcessId: async () => 4242,
    pollMpvWindows: () => mpvVisible({ x: 7 }),
    watchWindowLocation: () => null,
  });

  pollOnce(tracker);
  await flushPromises();
  pollOnce(tracker);
  assert.equal(tracker.getGeometry()?.x, 7);
  tracker.stop();
});
