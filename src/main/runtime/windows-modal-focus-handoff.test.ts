import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowsModalFocusHandoff } from './windows-modal-focus-handoff';

const MPV_HWND = 100;
const OTHER_HWND = 200;

function createHarness(
  options: { platform?: NodeJS.Platform; modalFocused?: boolean; watchFails?: boolean } = {},
) {
  const calls: string[] = [];
  let foregroundHwnd: number | null = OTHER_HWND;
  let mpvHwnd: number | null = MPV_HWND;
  let foregroundListener: ((hwnd: number) => void) | null = null;
  let nextTimerId = 1;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  let modalWindow: {
    isDestroyed: () => boolean;
    isVisible: () => boolean;
    isFocused: () => boolean;
    focus: () => void;
    webContents: { focus: () => void };
  } | null = {
    isDestroyed: () => false,
    isVisible: () => true,
    isFocused: () => options.modalFocused === true,
    focus: () => calls.push('focus'),
    webContents: { focus: () => calls.push('webContents-focus') },
  };
  const handoff = createWindowsModalFocusHandoff({
    platform: options.platform ?? 'win32',
    getModalWindow: () => modalWindow,
    getMpvWindowHandle: () => mpvHwnd,
    getForegroundWindowHandle: () => foregroundHwnd,
    watchForegroundWindow: (listener) => {
      calls.push('watch-start');
      if (options.watchFails) return null;
      foregroundListener = listener;
      return () => {
        foregroundListener = null;
        calls.push('watch-stop');
      };
    },
    activateNativeWindow: () => {
      calls.push('activate');
      return true;
    },
    warn: (message) => calls.push(`warn: ${message}`),
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = nextTimerId++;
      timers.set(id, { callback, delayMs });
      return id as never;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as unknown as number);
    },
  });
  const runTimers = () => {
    for (const [id, timer] of [...timers]) {
      timers.delete(id);
      timer.callback();
    }
  };
  return {
    calls,
    handoff,
    timers,
    runTimers,
    /** Windows reports a new foreground window, the way the event hook would. */
    switchForegroundTo: (hwnd: number) => {
      foregroundHwnd = hwnd;
      foregroundListener?.(hwnd);
    },
    hasListener: () => foregroundListener !== null,
    setMpvHwnd: (hwnd: number | null) => {
      mpvHwnd = hwnd;
    },
    clearModal: () => {
      modalWindow = null;
    },
  };
}

const handoffCalls = ['activate', 'focus', 'webContents-focus'];

test('hands the foreground back to the open modal when Windows reports the tracked mpv in front', () => {
  const h = createHarness();
  h.handoff.setModalActive(true);
  h.runTimers();
  assert.deepEqual(h.calls, ['watch-start']);

  h.switchForegroundTo(MPV_HWND);
  // The handoff waits until the OS callback has returned.
  assert.deepEqual(h.calls, ['watch-start']);
  h.runTimers();
  assert.deepEqual(h.calls, ['watch-start', ...handoffCalls]);
});

test('ignores foreground changes to windows other than the tracked mpv', () => {
  const h = createHarness();
  h.handoff.setModalActive(true);
  h.runTimers();
  h.switchForegroundTo(OTHER_HWND);
  h.runTimers();
  assert.deepEqual(h.calls, ['watch-start']);

  // An mpv that isn't tracked (yet) can't be told apart from an unrelated one.
  h.setMpvHwnd(null);
  h.switchForegroundTo(MPV_HWND);
  h.runTimers();
  assert.deepEqual(h.calls, ['watch-start']);
});

test('merges a burst of foreground events into one handoff', () => {
  const h = createHarness();
  h.handoff.setModalActive(true);
  h.runTimers();
  h.switchForegroundTo(MPV_HWND);
  h.switchForegroundTo(MPV_HWND);
  h.runTimers();
  assert.equal(h.calls.filter((call) => call === 'activate').length, 1);

  h.switchForegroundTo(OTHER_HWND);
  h.switchForegroundTo(MPV_HWND);
  h.runTimers();
  assert.equal(h.calls.filter((call) => call === 'activate').length, 2);
});

test('skips a queued handoff when mpv lost the foreground again before it ran', () => {
  const h = createHarness();
  h.handoff.setModalActive(true);
  h.runTimers();
  h.switchForegroundTo(MPV_HWND);
  h.switchForegroundTo(OTHER_HWND);
  h.runTimers();
  assert.deepEqual(h.calls, ['watch-start']);
});

test('hands off once shortly after opening when mpv is already in front', () => {
  const h = createHarness();
  h.switchForegroundTo(MPV_HWND);
  h.handoff.setModalActive(true);
  assert.deepEqual(h.calls, ['watch-start']);
  assert.deepEqual(
    [...h.timers.values()].map((timer) => timer.delayMs),
    [100],
  );
  h.runTimers();
  assert.deepEqual(h.calls, ['watch-start', ...handoffCalls]);
});

test('leaves focus alone when the modal is already focused or gone', () => {
  const focused = createHarness({ modalFocused: true });
  focused.handoff.setModalActive(true);
  focused.switchForegroundTo(MPV_HWND);
  focused.runTimers();
  assert.deepEqual(focused.calls, ['watch-start']);

  const gone = createHarness();
  gone.handoff.setModalActive(true);
  gone.clearModal();
  gone.switchForegroundTo(MPV_HWND);
  gone.runTimers();
  assert.deepEqual(gone.calls, ['watch-start']);
});

test('stops watching and drops queued handoffs when the last modal closes', () => {
  const h = createHarness();
  h.handoff.setModalActive(true);
  h.handoff.setModalActive(true);
  h.switchForegroundTo(MPV_HWND);
  h.handoff.setModalActive(false);
  h.handoff.setModalActive(false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.hasListener(), false);
  h.runTimers();
  assert.deepEqual(h.calls, ['watch-start', 'watch-stop']);
});

test('watches again for the next modal', () => {
  const h = createHarness();
  h.handoff.setModalActive(true);
  h.handoff.setModalActive(false);
  h.handoff.setModalActive(true);
  h.runTimers();
  h.switchForegroundTo(MPV_HWND);
  h.runTimers();
  assert.deepEqual(h.calls, ['watch-start', 'watch-stop', 'watch-start', ...handoffCalls]);
});

test('warns once when the foreground watch cannot be set up', () => {
  const h = createHarness({ watchFails: true });
  h.handoff.setModalActive(true);
  h.handoff.setModalActive(false);
  h.handoff.setModalActive(true);
  assert.equal(h.calls.filter((call) => call.startsWith('warn: ')).length, 1);
});

test('does nothing outside Windows', () => {
  const h = createHarness({ platform: 'darwin' });
  h.handoff.setModalActive(true);
  h.switchForegroundTo(MPV_HWND);
  h.runTimers();
  assert.deepEqual(h.calls, []);
  assert.equal(h.timers.size, 0);
});
