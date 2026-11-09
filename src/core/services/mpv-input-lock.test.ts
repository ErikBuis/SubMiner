import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MPV_INPUT_LOCK_BLOCKED_KEY_MESSAGE,
  MPV_INPUT_LOCK_SECTION,
  buildMpvInputLockCommands,
  buildMpvInputUnlockCommands,
  createMpvInputLock,
} from './mpv-input-lock';

function createHarness(options: { connected?: boolean } = {}) {
  const commands: Array<Array<string | number>> = [];
  const client = {
    connected: options.connected ?? true,
    send: ({ command }: { command: Array<string | number> }) => commands.push(command),
  };
  let blockedKeys = 0;
  const lock = createMpvInputLock({
    getMpvClient: () => client,
    onBlockedKey: () => {
      blockedKeys += 1;
    },
  });
  return { lock, client, commands, blockedKeys: () => blockedKeys };
}

test('the lock section shadows every earlier section and keeps the close button', () => {
  const [define, enable, state] = buildMpvInputLockCommands();
  assert.equal(define?.[0], 'define-section');
  assert.equal(define?.[1], MPV_INPUT_LOCK_SECTION);
  assert.equal(define?.[3], 'force');
  const bindings = String(define?.[2]).trim().split('\n');
  assert.deepEqual(bindings, [
    'CLOSE_WIN quit',
    'MOUSE_MOVE ignore',
    'MOUSE_ENTER ignore',
    'MOUSE_LEAVE ignore',
    `UNMAPPED script-message ${MPV_INPUT_LOCK_BLOCKED_KEY_MESSAGE}`,
  ]);
  assert.deepEqual(enable, [
    'enable-section',
    MPV_INPUT_LOCK_SECTION,
    'exclusive+allow-hide-cursor+allow-vo-dragging',
  ]);
  assert.deepEqual(state, ['script-message', 'subminer-input-lock', 'on']);
  assert.deepEqual(buildMpvInputUnlockCommands(), [
    ['disable-section', MPV_INPUT_LOCK_SECTION],
    ['script-message', 'subminer-input-lock', 'off'],
  ]);
});

test('lock and unlock send their commands once each', () => {
  const { lock, commands } = createHarness();

  lock.lock();
  lock.lock();
  assert.equal(lock.isLocked(), true);
  assert.deepEqual(commands, buildMpvInputLockCommands());

  commands.length = 0;
  lock.unlock();
  lock.unlock();
  assert.equal(lock.isLocked(), false);
  assert.deepEqual(commands, buildMpvInputUnlockCommands());
});

test('a lock taken while mpv is disconnected is applied once it connects', () => {
  const { lock, client, commands } = createHarness({ connected: false });

  lock.lock();
  assert.deepEqual(commands, []);

  client.connected = true;
  lock.sync();
  assert.deepEqual(commands, buildMpvInputLockCommands());
});

test('sync re-applies a held lock and clears a stale one otherwise', () => {
  const { lock, commands } = createHarness();

  lock.sync();
  assert.deepEqual(commands, buildMpvInputUnlockCommands());

  lock.lock();
  commands.length = 0;
  lock.sync();
  assert.deepEqual(commands, buildMpvInputLockCommands());
});

test('a blocked key gets the current state back and a notice while locked', () => {
  const { lock, commands, blockedKeys } = createHarness();

  assert.equal(lock.handleClientMessage([MPV_INPUT_LOCK_BLOCKED_KEY_MESSAGE]), true);
  assert.deepEqual(commands, buildMpvInputUnlockCommands());
  assert.equal(blockedKeys(), 0);

  lock.lock();
  commands.length = 0;
  assert.equal(lock.handleClientMessage([MPV_INPUT_LOCK_BLOCKED_KEY_MESSAGE]), true);
  assert.deepEqual(commands, buildMpvInputLockCommands());
  assert.equal(blockedKeys(), 1);
});

test('other client messages are left alone', () => {
  const { lock, commands } = createHarness();
  lock.lock();
  commands.length = 0;

  assert.equal(lock.handleClientMessage(['subminer-skip-intro']), false);
  assert.equal(lock.handleClientMessage([]), false);
  assert.deepEqual(commands, []);
});
