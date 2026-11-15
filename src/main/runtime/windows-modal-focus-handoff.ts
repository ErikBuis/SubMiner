type ModalWindowLike = {
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  isFocused: () => boolean;
  focus: () => void;
  webContents: { focus: () => void };
};

type TimerHandle = NonNullable<Parameters<typeof globalThis.clearTimeout>[0]>;

export type WindowsModalFocusHandoffDeps<TWindow extends ModalWindowLike> = {
  platform: NodeJS.Platform;
  getModalWindow: () => TWindow | null;
  /** The tracked mpv window (not just any mpv process), or null while it isn't found. */
  getMpvWindowHandle: () => number | null;
  getForegroundWindowHandle: () => number | null;
  /**
   * Calls `onForeground` with the new foreground window whenever another process's window
   * becomes the foreground. Returns a function that stops watching, or null if watching failed.
   */
  watchForegroundWindow: (onForeground: (hwnd: number) => void) => (() => void) | null;
  /** Raises the window to the foreground at the OS level; Electron's focus() alone can't. */
  activateNativeWindow: (window: TWindow) => boolean;
  warn?: (message: string) => void;
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
};

// The modal window is shown and focused right after it becomes active. If mpv still holds the
// foreground once that has settled, the modal's own focus request was refused. Checked every
// 100 ms for up to a second while the modal window or the mpv window isn't known yet.
const OPEN_CHECK_DELAY_MS = 100;
const OPEN_CHECK_ATTEMPTS = 10;

/**
 * Windows: while an overlay modal is open, switching back to mpv (alt+tab, taskbar, or a click
 * on the video) makes mpv the foreground window, so keys like Space and P reach mpv and resume
 * playback behind the dialog. Windows tells us whenever the foreground window changes, and when
 * the new one is the tracked mpv, the foreground goes back to the modal.
 */
export function createWindowsModalFocusHandoff<TWindow extends ModalWindowLike>(
  deps: WindowsModalFocusHandoffDeps<TWindow>,
) {
  const schedule = deps.setTimeout ?? globalThis.setTimeout;
  const cancel = deps.clearTimeout ?? globalThis.clearTimeout;
  let stopWatching: (() => void) | null = null;
  let active = false;
  let openCheck: TimerHandle | null = null;
  let pendingHandoff: TimerHandle | null = null;
  let watchFailureWarned = false;

  /** Returns false when the modal isn't ready yet, so the open check can try again. */
  function handOffIfMpvInFront(): boolean {
    if (!active) return true;
    try {
      const mpvHwnd = deps.getMpvWindowHandle();
      if (mpvHwnd === null) return false;
      if (deps.getForegroundWindowHandle() !== mpvHwnd) return true;

      const modalWindow = deps.getModalWindow();
      if (!modalWindow || modalWindow.isDestroyed() || !modalWindow.isVisible()) return false;
      if (modalWindow.isFocused()) return true;

      if (!deps.activateNativeWindow(modalWindow)) {
        deps.warn?.('Windows refused to give the open dialog the foreground back from mpv');
      }
      modalWindow.focus();
      modalWindow.webContents.focus();
    } catch (error) {
      deps.warn?.(
        `Dialog focus handoff failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return true;
  }

  function onForeground(hwnd: number): void {
    if (!active || hwnd !== deps.getMpvWindowHandle()) return;
    // Leave the OS callback first, and coalesce a burst of foreground changes into one handoff.
    if (pendingHandoff !== null) return;
    pendingHandoff = schedule(() => {
      pendingHandoff = null;
      handOffIfMpvInFront();
    }, 0);
  }

  // A modal window that is still being created, or an mpv window the tracker hasn't found yet,
  // gets a few more tries. Once both exist, mpv coming to the front raises an event instead.
  function scheduleOpenCheck(attemptsLeft: number): void {
    openCheck = schedule(() => {
      openCheck = null;
      if (!handOffIfMpvInFront() && attemptsLeft > 1) scheduleOpenCheck(attemptsLeft - 1);
    }, OPEN_CHECK_DELAY_MS);
  }

  function clearTimers(): void {
    if (openCheck !== null) cancel(openCheck);
    if (pendingHandoff !== null) cancel(pendingHandoff);
    openCheck = null;
    pendingHandoff = null;
  }

  function setModalActive(nextActive: boolean): void {
    if (deps.platform !== 'win32') return;
    if (nextActive === active) return;
    active = nextActive;

    if (!active) {
      clearTimers();
      stopWatching?.();
      stopWatching = null;
      return;
    }

    stopWatching = deps.watchForegroundWindow(onForeground);
    if (!stopWatching && !watchFailureWarned) {
      watchFailureWarned = true;
      deps.warn?.('Could not watch the Windows foreground window; dialog focus handoff is off');
    }
    scheduleOpenCheck(OPEN_CHECK_ATTEMPTS);
  }

  return { setModalActive };
}
