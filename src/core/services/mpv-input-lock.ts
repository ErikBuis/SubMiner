/**
 * Locks mpv's own key and mouse bindings while SubMiner shows a dialog over playback (the
 * media timing review), so a key that reaches the mpv window behind it changes nothing.
 *
 * mpv looks a key up in its enabled input sections, newest first. An `exclusive` section ends
 * that search, so a key it does not bind reaches none of the sections enabled before it: the
 * default and input.conf bindings, and the (forced) bindings of scripts such as the OSC and
 * SubMiner's own mpv plugin. SubMiner drives mpv with IPC commands, which are not keys and
 * keep working; keys the overlay forwards to mpv (`keydown`/`keypress`) are blocked too.
 *
 * A script that changes its bindings re-enables its sections above the lock. SubMiner's
 * plugin follows the `on`/`off` state message and puts the lock back on top after changing
 * its own bindings; it also releases the lock when a blocked key gets no answer from the app.
 */

export const MPV_INPUT_LOCK_SECTION = 'subminer-input-lock';
/** Script message carrying `on` or `off`, so SubMiner's mpv plugin tracks the lock. */
export const MPV_INPUT_LOCK_STATE_MESSAGE = 'subminer-input-lock';
/** Script message the lock sends for every key or button it swallows. */
export const MPV_INPUT_LOCK_BLOCKED_KEY_MESSAGE = 'subminer-input-lock-blocked-key';

const MPV_INPUT_LOCK_SECTION_FLAGS = 'exclusive+allow-hide-cursor+allow-vo-dragging';
const MPV_INPUT_LOCK_SECTION_CONTENTS = [
  // The window's close button still quits mpv.
  'CLOSE_WIN quit',
  // Moving the pointer is not a key press to report.
  'MOUSE_MOVE ignore',
  'MOUSE_ENTER ignore',
  'MOUSE_LEAVE ignore',
  // Any other key or button: report it instead of running mpv's binding.
  `UNMAPPED script-message ${MPV_INPUT_LOCK_BLOCKED_KEY_MESSAGE}`,
  '',
].join('\n');

type MpvCommand = Array<string | number>;

export interface MpvInputLockClient {
  connected: boolean;
  send: (payload: { command: MpvCommand }) => void;
}

export function buildMpvInputLockCommands(): MpvCommand[] {
  return [
    ['define-section', MPV_INPUT_LOCK_SECTION, MPV_INPUT_LOCK_SECTION_CONTENTS, 'force'],
    ['enable-section', MPV_INPUT_LOCK_SECTION, MPV_INPUT_LOCK_SECTION_FLAGS],
    ['script-message', MPV_INPUT_LOCK_STATE_MESSAGE, 'on'],
  ];
}

export function buildMpvInputUnlockCommands(): MpvCommand[] {
  return [
    ['disable-section', MPV_INPUT_LOCK_SECTION],
    ['script-message', MPV_INPUT_LOCK_STATE_MESSAGE, 'off'],
  ];
}

export interface MpvInputLock {
  /** Locks mpv's input; does nothing while already locked. */
  lock(): void;
  /** Gives mpv its input back; does nothing while unlocked. */
  unlock(): void;
  /**
   * Sends the current state again. After an mpv (re)connect this re-applies a held lock and
   * clears one that an earlier SubMiner left behind (it crashed with a dialog open).
   */
  sync(): void;
  /** Answers the lock's blocked-key report; returns whether the message was the lock's. */
  handleClientMessage(args: readonly string[]): boolean;
  isLocked(): boolean;
}

export function createMpvInputLock(deps: {
  getMpvClient: () => MpvInputLockClient | null;
  /** A key reached mpv while locked, e.g. to show why it did nothing. */
  onBlockedKey?: () => void;
}): MpvInputLock {
  let locked = false;

  function sync(): void {
    const client = deps.getMpvClient();
    if (!client?.connected) return;
    const commands = locked ? buildMpvInputLockCommands() : buildMpvInputUnlockCommands();
    for (const command of commands) client.send({ command });
  }

  return {
    lock() {
      if (locked) return;
      locked = true;
      sync();
    },
    unlock() {
      if (!locked) return;
      locked = false;
      sync();
    },
    sync,
    handleClientMessage(args) {
      if (args[0] !== MPV_INPUT_LOCK_BLOCKED_KEY_MESSAGE) return false;
      // The answer tells the plugin SubMiner is still here; it also restores a lock another
      // script lifted, or clears one that should not be there.
      sync();
      if (locked) deps.onBlockedKey?.();
      return true;
    },
    isLocked: () => locked,
  };
}
