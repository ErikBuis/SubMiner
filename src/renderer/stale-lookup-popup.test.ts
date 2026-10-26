import test from 'node:test';
import assert from 'node:assert/strict';

import { createStaleLookupPopupCloser } from './stale-lookup-popup.js';

function setup(
  options: {
    paused?: boolean | null;
    popupOpen?: boolean;
    keyboardMode?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let popupOpen = options.popupOpen ?? true;
  const closer = createStaleLookupPopupCloser({
    isKeyboardDrivenModeEnabled: () => options.keyboardMode ?? false,
    isLookupPopupOpen: () => popupOpen,
    getPlaybackPaused: async () => options.paused ?? true,
    releasePopupPause: () => calls.push('release'),
    closeLookupPopup: () => {
      calls.push('close');
      popupOpen = false;
    },
  });
  return { calls, closer };
}

test('a new line while paused closes the lookup popup without resuming playback', async () => {
  const { calls, closer } = setup();

  await closer.handleSubtitleText('  放課後\r\n');
  // The annotated upgrade of the same cue arrives with normalized whitespace.
  await closer.handleSubtitleText('放課後');
  assert.deepEqual(calls, []);

  await closer.handleSubtitleText('次の台詞');
  assert.deepEqual(calls, ['release', 'close']);
});

test('line changes during playback keep the lookup popup open', async () => {
  const { calls, closer } = setup({ paused: false });

  await closer.handleSubtitleText('一');
  await closer.handleSubtitleText('二');

  assert.deepEqual(calls, []);
});

test('keyboard-driven mode and a closed popup are left alone', async () => {
  for (const options of [{ keyboardMode: true }, { popupOpen: false }]) {
    const { calls, closer } = setup(options);
    await closer.handleSubtitleText('一');
    await closer.handleSubtitleText('二');
    assert.deepEqual(calls, []);
  }
});

test('only the newest line change outside keyboard mode closes the popup', async () => {
  const calls: string[] = [];
  let keyboardMode = false;
  let resolvePaused: (paused: boolean) => void = () => {};
  const closer = createStaleLookupPopupCloser({
    isKeyboardDrivenModeEnabled: () => keyboardMode,
    isLookupPopupOpen: () => true,
    getPlaybackPaused: () =>
      new Promise<boolean>((resolve) => {
        resolvePaused = resolve;
      }),
    releasePopupPause: () => calls.push('release'),
    closeLookupPopup: () => calls.push('close'),
  });

  void closer.handleSubtitleText('一');
  const superseded = closer.handleSubtitleText('二');
  const firstAnswer = resolvePaused;
  const newer = closer.handleSubtitleText('三');
  const newerAnswer = resolvePaused;
  // A repeat of the same line (raw, then annotated) must not cancel the newer check.
  void closer.handleSubtitleText('三');
  firstAnswer(true);
  await superseded;
  assert.deepEqual(calls, []);
  newerAnswer(true);
  await newer;
  assert.deepEqual(calls, ['release', 'close']);
  calls.length = 0;

  const pending = closer.handleSubtitleText('四');
  keyboardMode = true;
  resolvePaused(true);
  await pending;

  assert.deepEqual(calls, []);
});
