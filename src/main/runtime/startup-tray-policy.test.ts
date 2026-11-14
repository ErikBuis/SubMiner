import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveManagedPlaybackAttachment,
  shouldEnsureTrayOnStartupForInitialArgs,
  shouldQuitOnMpvShutdownForTrayState,
  shouldQuitOnWindowAllClosedForTrayState,
} from './startup-tray-policy';

test('startup tray policy enables tray on Windows by default', () => {
  assert.equal(shouldEnsureTrayOnStartupForInitialArgs('win32', null), true);
});

test('startup tray policy skips tray for direct youtube playback on Windows', () => {
  assert.equal(
    shouldEnsureTrayOnStartupForInitialArgs('win32', {
      youtubePlay: 'https://www.youtube.com/watch?v=abc',
    } as never),
    false,
  );
});

test('startup tray policy skips tray outside Windows', () => {
  assert.equal(shouldEnsureTrayOnStartupForInitialArgs('linux', null), false);
});

test('window-all-closed keeps tray-resident app alive', () => {
  assert.equal(
    shouldQuitOnWindowAllClosedForTrayState({ backgroundMode: false, hasTray: true }),
    false,
  );
});

test('window-all-closed quits non-background app without tray', () => {
  assert.equal(
    shouldQuitOnWindowAllClosedForTrayState({ backgroundMode: false, hasTray: false }),
    true,
  );
});

test('window-all-closed keeps background app alive without tray', () => {
  assert.equal(
    shouldQuitOnWindowAllClosedForTrayState({ backgroundMode: true, hasTray: false }),
    false,
  );
});

test('mpv shutdown quits managed background playback despite tray residency', () => {
  assert.equal(
    shouldQuitOnMpvShutdownForTrayState({
      managedPlayback: true,
      backgroundMode: true,
      hasTray: true,
    }),
    true,
  );
});

test('mpv shutdown quits standalone managed playback without tray residency', () => {
  assert.equal(
    shouldQuitOnMpvShutdownForTrayState({
      managedPlayback: true,
      backgroundMode: false,
      hasTray: false,
    }),
    true,
  );
});

test('mpv shutdown keeps unmanaged background tray app alive', () => {
  assert.equal(
    shouldQuitOnMpvShutdownForTrayState({
      managedPlayback: false,
      backgroundMode: true,
      hasTray: true,
    }),
    false,
  );
});

test('a managed launch attached to a running app makes mpv shutdown quit it', () => {
  const attached = resolveManagedPlaybackAttachment(
    false,
    { start: true, managedPlayback: true },
    'second-instance',
  );
  assert.equal(attached, true);
  assert.equal(
    shouldQuitOnMpvShutdownForTrayState({
      managedPlayback: attached,
      backgroundMode: true,
      hasTray: true,
    }),
    true,
  );
});

test('an unmanaged --start from another instance releases a managed attachment', () => {
  assert.equal(
    resolveManagedPlaybackAttachment(
      true,
      { start: true, managedPlayback: false },
      'second-instance',
    ),
    false,
  );
});

test('commands without --start keep the current managed attachment', () => {
  for (const current of [true, false]) {
    assert.equal(
      resolveManagedPlaybackAttachment(
        current,
        { start: false, managedPlayback: false },
        'second-instance',
      ),
      current,
    );
  }
});

test('initial args never count as an attachment', () => {
  assert.equal(
    resolveManagedPlaybackAttachment(false, { start: true, managedPlayback: true }, 'initial'),
    false,
  );
});
