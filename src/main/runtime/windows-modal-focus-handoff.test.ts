import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowsModalFocusHandoff } from './windows-modal-focus-handoff';

function createHarness(options: { platform?: NodeJS.Platform; modalFocused?: boolean } = {}) {
  const calls: string[] = [];
  let foreground: string | null = 'subminer';
  let pollCallback: (() => void) | null = null;
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
    getForegroundProcessName: () => foreground,
    activateNativeWindow: () => {
      calls.push('activate');
      return true;
    },
    setInterval: (callback) => {
      pollCallback = callback;
      calls.push('poll-start');
      return 1 as never;
    },
    clearInterval: () => {
      pollCallback = null;
      calls.push('poll-stop');
    },
  });
  return {
    calls,
    handoff,
    setForeground: (name: string | null) => {
      foreground = name;
    },
    clearModal: () => {
      modalWindow = null;
    },
    runPoll: () => pollCallback?.(),
  };
}

test('hands the foreground back to the open modal when mpv becomes the foreground', () => {
  const h = createHarness();
  h.handoff.setModalActive(true);
  h.runPoll();
  assert.deepEqual(h.calls, ['poll-start']);

  h.setForeground('mpv');
  h.runPoll();
  assert.deepEqual(h.calls, ['poll-start', 'activate', 'focus', 'webContents-focus']);
});

test('hands off once per switch to mpv instead of on every poll', () => {
  const h = createHarness();
  h.handoff.setModalActive(true);
  h.setForeground('mpv');
  h.runPoll();
  h.runPoll();
  assert.equal(h.calls.filter((call) => call === 'activate').length, 1);

  h.setForeground('firefox');
  h.runPoll();
  h.setForeground('MPV ');
  h.runPoll();
  assert.equal(h.calls.filter((call) => call === 'activate').length, 2);
});

test('hands off when mpv is already the foreground as the modal opens', () => {
  const h = createHarness();
  h.setForeground('mpv');
  h.handoff.setModalActive(true);
  h.runPoll();
  assert.ok(h.calls.includes('activate'));
});

test('leaves focus alone when the modal is already focused or gone', () => {
  const focused = createHarness({ modalFocused: true });
  focused.handoff.setModalActive(true);
  focused.setForeground('mpv');
  focused.runPoll();
  assert.deepEqual(focused.calls, ['poll-start']);

  const gone = createHarness();
  gone.handoff.setModalActive(true);
  gone.clearModal();
  gone.setForeground('mpv');
  gone.runPoll();
  assert.deepEqual(gone.calls, ['poll-start']);
});

test('stops polling when the last modal closes', () => {
  const h = createHarness();
  h.handoff.setModalActive(true);
  h.handoff.setModalActive(true);
  h.handoff.setModalActive(false);
  h.handoff.setModalActive(false);
  h.setForeground('mpv');
  h.runPoll();
  assert.deepEqual(h.calls, ['poll-start', 'poll-stop']);
});

test('does nothing outside Windows', () => {
  const h = createHarness({ platform: 'darwin' });
  h.handoff.setModalActive(true);
  h.setForeground('mpv');
  h.runPoll();
  assert.deepEqual(h.calls, []);
});
