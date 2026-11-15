import koffi from 'koffi';
import { resolveClientAreaBounds, type WindowBounds } from './window-client-area';

const user32 = koffi.load('user32.dll');
const dwmapi = koffi.load('dwmapi.dll');
const kernel32 = koffi.load('kernel32.dll');

const RECT = koffi.struct('RECT', {
  Left: 'int',
  Top: 'int',
  Right: 'int',
  Bottom: 'int',
});

// Registered by name for the ClientToScreen prototype below.
koffi.struct('POINT', {
  x: 'int',
  y: 'int',
});

// Registered by name for the DwmExtendFrameIntoClientArea prototype below.
koffi.struct('MARGINS', {
  cxLeftWidth: 'int',
  cxRightWidth: 'int',
  cyTopHeight: 'int',
  cyBottomHeight: 'int',
});

// Top-level windows are walked with FindWindowExW instead of EnumWindows, because EnumWindows
// needs a koffi callback. On recent Windows 11 builds, a GetProcAddress made by koffi inside such
// a callback can take a stack trace that hits koffi's stack bounds, and the whole app crashes.
const FindWindowExW = user32.func(
  'intptr __stdcall FindWindowExW(intptr hWndParent, intptr hWndChildAfter, const char16_t *lpszClass, const char16_t *lpszWindow)',
);
const WINEVENTPROC = koffi.proto(
  'void __stdcall WINEVENTPROC(intptr hWinEventHook, uint event, intptr hwnd, long idObject, long idChild, uint idEventThread, uint dwmsEventTime)',
);
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr hwnd)');
const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()');
const AllowSetForegroundWindow = user32.func(
  'bool __stdcall AllowSetForegroundWindow(uint dwProcessId)',
);
const SetWindowPos = user32.func(
  'bool __stdcall SetWindowPos(intptr hwnd, intptr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)',
);
const GetWindowThreadProcessId = user32.func(
  'uint __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint *lpdwProcessId)',
);
const GetWindowLongW = user32.func('int __stdcall GetWindowLongW(intptr hwnd, int nIndex)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr hwnd)');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr hwnd)');
const AttachThreadInput = user32.func(
  'int __stdcall AttachThreadInput(uint idAttach, uint idAttachTo, int fAttach)',
);
const SetWindowLongPtrW = user32.func(
  'intptr __stdcall SetWindowLongPtrW(intptr hwnd, int nIndex, intptr dwNewLong)',
);
const GetWindowFn = user32.func('intptr __stdcall GetWindow(intptr hwnd, uint uCmd)');
const SetWinEventHook = user32.func(
  'intptr __stdcall SetWinEventHook(uint eventMin, uint eventMax, intptr hmodWinEventProc, WINEVENTPROC *pfnWinEventProc, uint idProcess, uint idThread, uint dwFlags)',
);
const UnhookWinEvent = user32.func('bool __stdcall UnhookWinEvent(intptr hWinEventHook)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr hwnd, _Out_ RECT *lpRect)');
const GetClientRect = user32.func('bool __stdcall GetClientRect(intptr hwnd, _Out_ RECT *lpRect)');
const ClientToScreen = user32.func(
  'bool __stdcall ClientToScreen(intptr hwnd, _Inout_ POINT *lpPoint)',
);

const DwmGetWindowAttribute = dwmapi.func(
  'int __stdcall DwmGetWindowAttribute(intptr hwnd, uint dwAttribute, _Out_ RECT *pvAttribute, uint cbAttribute)',
);
const DwmExtendFrameIntoClientArea = dwmapi.func(
  'int __stdcall DwmExtendFrameIntoClientArea(intptr hwnd, MARGINS *pMarInset)',
);

const OpenProcess = kernel32.func(
  'intptr __stdcall OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId)',
);
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr hObject)');
const GetLastError = kernel32.func('uint __stdcall GetLastError()');
const GetCurrentThreadId = kernel32.func('uint __stdcall GetCurrentThreadId()');
const SetLastError = kernel32.func('void __stdcall SetLastError(uint dwErrCode)');
const QueryFullProcessImageNameW = kernel32.func(
  'bool __stdcall QueryFullProcessImageNameW(intptr hProcess, uint dwFlags, _Out_ uint16 *lpExeName, _Inout_ uint *lpdwSize)',
);

const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x00000008;
const GWLP_HWNDPARENT = -8;
const GW_HWNDPREV = 3;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOOWNERZORDER = 0x0200;
const SWP_FLAGS = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
const EVENT_SYSTEM_FOREGROUND = 0x0003;
const EVENT_OBJECT_LOCATIONCHANGE = 0x800b;
const WINEVENT_OUTOFCONTEXT = 0x0000;
const WINEVENT_SKIPOWNPROCESS = 0x0002;
const OBJID_WINDOW = 0;
const CALLBACK_UNREGISTER_DELAY_MS = 1_000;
const HWND_TOP = 0;
const HWND_BOTTOM = 1;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const MAX_TOP_LEVEL_WINDOWS = 10_000;
const MAX_WINDOW_WALK_RESTARTS = 3;
const ERROR_INVALID_WINDOW_HANDLE = 1400;

function extendOverlayFrameIntoClientArea(overlayHwnd: number): void {
  const hr = DwmExtendFrameIntoClientArea(overlayHwnd, {
    cxLeftWidth: -1,
    cxRightWidth: -1,
    cyTopHeight: -1,
    cyBottomHeight: -1,
  });
  if (hr !== 0) {
    throw new Error(`DwmExtendFrameIntoClientArea failed (${hr})`);
  }
}

function resetLastError(): void {
  SetLastError(0);
}

function assertSetWindowLongPtrSucceeded(operation: string, result: number): void {
  if (result !== 0) {
    return;
  }

  if (GetLastError() === 0) {
    return;
  }

  throw new Error(`${operation} failed (${GetLastError()})`);
}

function assertSetWindowPosSucceeded(operation: string, result: boolean): void {
  if (result) {
    return;
  }

  throw new Error(`${operation} failed (${GetLastError()})`);
}

function assertGetWindowLongSucceeded(operation: string, result: number): number {
  if (result !== 0 || GetLastError() === 0) {
    return result;
  }

  throw new Error(`${operation} failed (${GetLastError()})`);
}

export type { WindowBounds };

export interface MpvWindowMatch {
  hwnd: number;
  bounds: WindowBounds;
  /** The client area (the video, without title bar and borders), when it can be read. */
  contentBounds?: WindowBounds;
  area: number;
  isForeground: boolean;
}

export interface MpvPollResult {
  matches: MpvWindowMatch[];
  focusState: boolean;
  windowState: 'visible' | 'minimized' | 'not-found';
}

function getWindowBounds(hwnd: number): WindowBounds | null {
  const rect = { Left: 0, Top: 0, Right: 0, Bottom: 0 };
  const hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, koffi.sizeof(RECT));
  if (hr !== 0) {
    if (!GetWindowRect(hwnd, rect)) {
      return null;
    }
  }

  const width = rect.Right - rect.Left;
  const height = rect.Bottom - rect.Top;
  if (width <= 0 || height <= 0) return null;

  return { x: rect.Left, y: rect.Top, width, height };
}

function getClientAreaScreenRect(hwnd: number): WindowBounds | null {
  const rect = { Left: 0, Top: 0, Right: 0, Bottom: 0 };
  if (!GetClientRect(hwnd, rect)) return null;
  const origin = { x: 0, y: 0 };
  if (!ClientToScreen(hwnd, origin)) return null;
  return {
    x: origin.x,
    y: origin.y,
    width: rect.Right - rect.Left,
    height: rect.Bottom - rect.Top,
  };
}

function getProcessNameByPid(pid: number): string | null {
  const hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!hProcess) return null;

  try {
    const buffer = new Uint16Array(260);
    const size = new Uint32Array([260]);

    if (!QueryFullProcessImageNameW(hProcess, 0, buffer, size)) {
      return null;
    }

    const fullPath = String.fromCharCode(...buffer.slice(0, size[0]));
    const fileName = fullPath.split('\\').pop() || '';
    return fileName.replace(/\.exe$/i, '');
  } finally {
    CloseHandle(hProcess);
  }
}

// Short-lived cache so the 250ms poll doesn't re-query every top-level window's process
// on each pass. The TTL bounds staleness from PID reuse.
const PROCESS_NAME_CACHE_TTL_MS = 5_000;
const PROCESS_NAME_CACHE_PRUNE_THRESHOLD = 512;
const processNameCache = new Map<number, { name: string | null; expiresAtMs: number }>();

function getCachedProcessNameByPid(pid: number): string | null {
  const nowMs = Date.now();
  const cached = processNameCache.get(pid);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.name;
  }
  const name = getProcessNameByPid(pid);
  processNameCache.set(pid, { name, expiresAtMs: nowMs + PROCESS_NAME_CACHE_TTL_MS });
  return name;
}

function pruneExpiredProcessNames(nowMs: number): void {
  if (processNameCache.size <= PROCESS_NAME_CACHE_PRUNE_THRESHOLD) return;
  for (const [pid, entry] of processNameCache) {
    if (entry.expiresAtMs <= nowMs) {
      processNameCache.delete(pid);
    }
  }
}

// With a target PID only that process's windows match, whatever its executable is named.
// Without one, any process named mpv matches.
export function findMpvWindows(targetPid?: number | null): MpvPollResult {
  const foregroundHwnd = GetForegroundWindow();
  const matches: MpvWindowMatch[] = [];
  let hasMinimized = false;
  let hasFocused = false;
  pruneExpiredProcessNames(Date.now());

  const inspectWindow = (hwnd: number): void => {
    if (!IsWindowVisible(hwnd)) return;

    const pid = new Uint32Array(1);
    GetWindowThreadProcessId(hwnd, pid);
    const pidValue = pid[0]!;
    if (pidValue === 0) return;

    if (targetPid != null) {
      if (pidValue !== targetPid) return;
    } else if (getCachedProcessNameByPid(pidValue)?.toLowerCase() !== 'mpv') {
      return;
    }

    if (IsIconic(hwnd)) {
      hasMinimized = true;
      return;
    }

    const bounds = getWindowBounds(hwnd);
    if (!bounds) return;

    const isForeground = foregroundHwnd !== 0 && hwnd === foregroundHwnd;
    if (isForeground) hasFocused = true;

    const contentBounds = resolveClientAreaBounds(bounds, getClientAreaScreenRect(hwnd));
    matches.push({
      hwnd,
      bounds,
      ...(contentBounds ? { contentBounds } : {}),
      area: bounds.width * bounds.height,
      isForeground,
    });
  };

  // Unlike EnumWindows, this walk is no snapshot. When the window it stands on is destroyed,
  // the next step fails, so the walk starts over and skips the windows it already saw. The
  // cap only guards against a window list that changes so much that the walk never ends; a
  // desktop has far fewer top-level windows than this.
  const seen = new Set<number>();
  let hwnd = 0;
  let restarts = 0;
  for (let step = 0; step < MAX_TOP_LEVEL_WINDOWS; step++) {
    resetLastError();
    const next = FindWindowExW(0, hwnd, null, null);
    if (!next) {
      const walkBroke = hwnd !== 0 && GetLastError() === ERROR_INVALID_WINDOW_HANDLE;
      if (!walkBroke || restarts >= MAX_WINDOW_WALK_RESTARTS) break;
      restarts++;
      hwnd = 0;
      continue;
    }
    hwnd = next;
    if (seen.has(hwnd)) continue;
    seen.add(hwnd);
    inspectWindow(hwnd);
  }

  return {
    matches,
    focusState: hasFocused,
    windowState: matches.length > 0 ? 'visible' : hasMinimized ? 'minimized' : 'not-found',
  };
}

/**
 * Returns the bounds of a still-visible, non-minimized window, the same way the poll measures them.
 */
export function getVisibleWindowBounds(hwnd: number): WindowBounds | null {
  if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return null;
  return getWindowBounds(hwnd);
}

/**
 * Calls `onMove` with the window handle whenever a top-level window of process `pid` moves or
 * resizes. Windows delivers these events through the calling thread's message loop, which
 * Electron's main thread runs, so a dragged mpv window can be followed without polling.
 * Returns a function that stops watching.
 */
export function watchProcessWindowLocation(
  pid: number,
  onMove: (hwnd: number) => void,
): () => void {
  let stopped = false;
  const callback = koffi.register(
    (_hook: number, _event: number, hwnd: number, idObject: number) => {
      // Location events also fire for the caret, cursor and child objects; only whole windows matter.
      if (stopped || idObject !== OBJID_WINDOW || !hwnd) return;
      try {
        onMove(hwnd);
      } catch {
        // An exception must not reach the native caller.
      }
    },
    koffi.pointer(WINEVENTPROC),
  );
  const hook = SetWinEventHook(
    EVENT_OBJECT_LOCATIONCHANGE,
    EVENT_OBJECT_LOCATIONCHANGE,
    0,
    callback,
    pid,
    0,
    WINEVENT_OUTOFCONTEXT,
  );
  if (!hook) {
    koffi.unregister(callback);
    throw new Error('SetWinEventHook failed');
  }

  return () => {
    if (stopped) return;
    stopped = true;
    try {
      UnhookWinEvent(hook);
    } finally {
      // Events queued before the unhook can still be dispatched, and the stop may run from inside
      // the callback itself, so the callback stays registered (and ignores calls) a little longer.
      setTimeout(() => koffi.unregister(callback), CALLBACK_UNREGISTER_DELAY_MS);
    }
  };
}

export function getForegroundProcessName(): string | null {
  const foregroundHwnd = GetForegroundWindow();
  if (!foregroundHwnd) return null;

  const pid = new Uint32Array(1);
  GetWindowThreadProcessId(foregroundHwnd, pid);
  const pidValue = pid[0]!;
  if (pidValue === 0) return null;

  return getProcessNameByPid(pidValue);
}

export function getForegroundWindowHandle(): number | null {
  const foregroundHwnd = GetForegroundWindow();
  return foregroundHwnd ? foregroundHwnd : null;
}

/**
 * Calls `onForeground` whenever a window of another process becomes the foreground window.
 * Windows delivers these events through the calling thread's message loop, which Electron's
 * main thread runs, so no polling is needed. Returns a function that stops watching.
 */
export function watchForegroundWindow(onForeground: (hwnd: number) => void): () => void {
  const callback = koffi.register(
    (_hook: number, _event: number, hwnd: number, idObject: number) => {
      if (idObject !== OBJID_WINDOW || !hwnd) return;
      try {
        onForeground(hwnd);
      } catch {
        // An exception must not reach the native caller.
      }
    },
    koffi.pointer(WINEVENTPROC),
  );
  const hook = SetWinEventHook(
    EVENT_SYSTEM_FOREGROUND,
    EVENT_SYSTEM_FOREGROUND,
    0,
    callback,
    0,
    0,
    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
  );
  if (!hook) {
    koffi.unregister(callback);
    throw new Error('SetWinEventHook failed');
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try {
      UnhookWinEvent(hook);
    } finally {
      koffi.unregister(callback);
    }
  };
}

/**
 * Makes `hwnd` the foreground window even though another process (mpv) owns the foreground.
 * Windows refuses a plain SetForegroundWindow from a background process, so the calling
 * thread briefly shares the foreground thread's input state first.
 */
export function activateWindow(hwnd: number): boolean {
  const foregroundHwnd = GetForegroundWindow();
  if (foregroundHwnd === hwnd) return true;

  const currentThreadId = GetCurrentThreadId();
  const foregroundThreadId = foregroundHwnd
    ? GetWindowThreadProcessId(foregroundHwnd, new Uint32Array(1))
    : 0;
  const attached =
    foregroundThreadId !== 0 &&
    foregroundThreadId !== currentThreadId &&
    AttachThreadInput(currentThreadId, foregroundThreadId, 1) !== 0;
  try {
    BringWindowToTop(hwnd);
    return SetForegroundWindow(hwnd);
  } finally {
    if (attached) {
      AttachThreadInput(currentThreadId, foregroundThreadId, 0);
    }
  }
}

export function setOverlayOwner(overlayHwnd: number, mpvHwnd: number): void {
  resetLastError();
  const result = SetWindowLongPtrW(overlayHwnd, GWLP_HWNDPARENT, mpvHwnd);
  assertSetWindowLongPtrSucceeded('setOverlayOwner', result);
  extendOverlayFrameIntoClientArea(overlayHwnd);
}

export function ensureOverlayTransparency(overlayHwnd: number): void {
  extendOverlayFrameIntoClientArea(overlayHwnd);
}

export function clearOverlayOwner(overlayHwnd: number): void {
  resetLastError();
  const result = SetWindowLongPtrW(overlayHwnd, GWLP_HWNDPARENT, 0);
  assertSetWindowLongPtrSucceeded('clearOverlayOwner', result);
}

export function bindOverlayAboveMpv(overlayHwnd: number, mpvHwnd: number): void {
  resetLastError();
  const ownerResult = SetWindowLongPtrW(overlayHwnd, GWLP_HWNDPARENT, mpvHwnd);
  assertSetWindowLongPtrSucceeded('bindOverlayAboveMpv owner assignment', ownerResult);

  resetLastError();
  const mpvExStyle = assertGetWindowLongSucceeded(
    'bindOverlayAboveMpv target window style',
    GetWindowLongW(mpvHwnd, GWL_EXSTYLE),
  );
  const mpvIsTopmost = (mpvExStyle & WS_EX_TOPMOST) !== 0;

  resetLastError();
  const overlayExStyle = assertGetWindowLongSucceeded(
    'bindOverlayAboveMpv overlay window style',
    GetWindowLongW(overlayHwnd, GWL_EXSTYLE),
  );
  const overlayIsTopmost = (overlayExStyle & WS_EX_TOPMOST) !== 0;

  if (mpvIsTopmost && !overlayIsTopmost) {
    resetLastError();
    const topmostResult = SetWindowPos(overlayHwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_FLAGS);
    assertSetWindowPosSucceeded('bindOverlayAboveMpv topmost adjustment', topmostResult);
  } else if (!mpvIsTopmost && overlayIsTopmost) {
    resetLastError();
    const notTopmostResult = SetWindowPos(overlayHwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_FLAGS);
    assertSetWindowPosSucceeded('bindOverlayAboveMpv notopmost adjustment', notTopmostResult);
  }

  const windowAboveMpv = GetWindowFn(mpvHwnd, GW_HWNDPREV);
  if (windowAboveMpv !== 0 && windowAboveMpv === overlayHwnd) return;

  let insertAfter = HWND_TOP;
  if (windowAboveMpv !== 0) {
    try {
      resetLastError();
      const aboveExStyle = assertGetWindowLongSucceeded(
        'bindOverlayAboveMpv window above style',
        GetWindowLongW(windowAboveMpv, GWL_EXSTYLE),
      );
      const aboveIsTopmost = (aboveExStyle & WS_EX_TOPMOST) !== 0;
      if (aboveIsTopmost === mpvIsTopmost) {
        insertAfter = windowAboveMpv;
      }
    } catch {
      insertAfter = HWND_TOP;
    }
  }

  resetLastError();
  const positionResult = SetWindowPos(overlayHwnd, insertAfter, 0, 0, 0, 0, SWP_FLAGS);
  assertSetWindowPosSucceeded('bindOverlayAboveMpv z-order adjustment', positionResult);
}

export function lowerOverlay(overlayHwnd: number): void {
  resetLastError();
  const notTopmostResult = SetWindowPos(overlayHwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_FLAGS);
  assertSetWindowPosSucceeded('lowerOverlay notopmost adjustment', notTopmostResult);

  resetLastError();
  const bottomResult = SetWindowPos(overlayHwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_FLAGS);
  assertSetWindowPosSucceeded('lowerOverlay bottom adjustment', bottomResult);
}

const ASFW_ANY = 0xffffffff;

/**
 * Lets the next window another process brings up (Anki's browser) take the foreground.
 * Windows only allows this while SubMiner itself may set the foreground, i.e. right after
 * the user clicked one of its windows. Without it the window opens behind mpv.
 */
export function allowAnyProcessToSetForeground(): boolean {
  return AllowSetForegroundWindow(ASFW_ANY);
}
