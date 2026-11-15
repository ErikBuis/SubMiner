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

test('a launcher handoff to a running app makes mpv shutdown quit it', () => {
  const attached = resolveManagedPlaybackAttachment(
    false,
    { start: true, quitWithMpv: true },
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

test('the mpv plugin handing its session to a running tray app does not make it quit', () => {
  assert.equal(
    resolveManagedPlaybackAttachment(false, { start: true, quitWithMpv: false }, 'second-instance'),
    false,
  );
});

test('later commands keep a launcher handoff', () => {
  for (const args of [
    { start: true, quitWithMpv: false },
    { start: false, quitWithMpv: false },
  ]) {
    assert.equal(resolveManagedPlaybackAttachment(true, args, 'second-instance'), true);
  }
});

test('initial args never count as a launcher handoff', () => {
  assert.equal(
    resolveManagedPlaybackAttachment(false, { start: true, quitWithMpv: true }, 'initial'),
    false,
  );
});
