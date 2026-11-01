type ModalWindowLike = {
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  isFocused: () => boolean;
  focus: () => void;
  webContents: { focus: () => void };
};

type PollHandle = NonNullable<Parameters<typeof globalThis.clearInterval>[0]>;

export type WindowsModalFocusHandoffDeps<TWindow extends ModalWindowLike> = {
  platform: NodeJS.Platform;
  getModalWindow: () => TWindow | null;
  getForegroundProcessName: () => string | null;
  /** Raises the window to the foreground at the OS level; Electron's focus() alone can't. */
  activateNativeWindow: (window: TWindow) => boolean;
  setInterval?: (callback: () => void, delayMs: number) => PollHandle;
  clearInterval?: (handle: PollHandle) => void;
};

const FOREGROUND_POLL_INTERVAL_MS = 100;

/**
 * Windows: while an overlay modal is open, switching back to mpv (alt+tab, taskbar, or a click
 * on the video) makes mpv the foreground window, so keys like Space and P reach mpv and resume
 * playback behind the dialog. Whenever mpv becomes the foreground, hand it back to the modal.
 */
export function createWindowsModalFocusHandoff<TWindow extends ModalWindowLike>(
  deps: WindowsModalFocusHandoffDeps<TWindow>,
) {
  const setPoll = deps.setInterval ?? globalThis.setInterval;
  const clearPoll = deps.clearInterval ?? globalThis.clearInterval;
  let poll: PollHandle | null = null;
  let lastForegroundProcessName: string | null = null;

  function tick(): void {
    const processName = deps.getForegroundProcessName()?.trim().toLowerCase() ?? null;
    const previousProcessName = lastForegroundProcessName;
    lastForegroundProcessName = processName;
    // Only on the switch to mpv, so a failed handoff is not retried every tick.
    if (processName !== 'mpv' || previousProcessName === 'mpv') return;

    const modalWindow = deps.getModalWindow();
    if (!modalWindow || modalWindow.isDestroyed() || !modalWindow.isVisible()) return;
    if (modalWindow.isFocused()) return;

    deps.activateNativeWindow(modalWindow);
    modalWindow.focus();
    modalWindow.webContents.focus();
  }

  function setModalActive(active: boolean): void {
    if (deps.platform !== 'win32') return;
    if (active) {
      if (poll !== null) return;
      lastForegroundProcessName = null;
      poll = setPoll(tick, FOREGROUND_POLL_INTERVAL_MS);
      return;
    }
    if (poll === null) return;
    clearPoll(poll);
    poll = null;
  }

  return { setModalActive, tick };
}
