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

  await closer.handleSubtitleText('放課後');
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
