// Throwaway Windows probe: does SetWinEventHook(EVENT_SYSTEM_FOREGROUND) deliver callbacks on
// Electron's main thread through koffi, and can the callback hand the foreground back?
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const win32 = require(path.resolve(__dirname, '../../probe-out/win32.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hwndOf = (w) => {
  const h = w.getNativeWindowHandle();
  return h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0);
};

app.whenReady().then(async () => {
  const results = { events: [], checks: {} };
  const win = new BrowserWindow({ width: 400, height: 300, show: true });
  await win.loadURL('data:text/html,<h1>probe</h1>');
  const own = hwndOf(win);
  console.log('own hwnd', own, 'foreground', win32.getForegroundWindowHandle());

  let handoffTarget = null;
  let microtasks = 0;
  const stop = win32.watchForegroundWindow((hwnd) => {
    results.events.push({ hwnd, at: Date.now(), proc: win32.getForegroundProcessName() });
    Promise.resolve().then(() => microtasks++);
    if (handoffTarget !== null && hwnd === handoffTarget) {
      setTimeout(() => {
        results.checks.handoffActivate = win32.activateWindow(own);
      }, 0);
    }
  });

  const child = spawn('notepad.exe', [], { detached: false });
  await sleep(2500);
  const found = win32.findMpvWindows(child.pid);
  const other = found.matches[0]?.hwnd ?? null;
  console.log('notepad pid', child.pid, 'hwnd', other, 'events so far', results.events.length);
  if (other === null) {
    console.log('NO NOTEPAD WINDOW');
  } else {
    // 1. Our process puts notepad in front: expect one event for notepad.
    win32.activateWindow(own);
    await sleep(500);
    const before = results.events.length;
    const t0 = Date.now();
    results.checks.activateOther = win32.activateWindow(other);
    await sleep(800);
    const evs = results.events.slice(before).filter((e) => e.hwnd === other);
    results.checks.eventForOther = evs.length > 0;
    results.checks.latencyMs = evs[0] ? evs[0].at - t0 : null;
    results.checks.foregroundIsOther = win32.getForegroundWindowHandle() === other;

    // 2. Our own window coming to front is skipped (WINEVENT_SKIPOWNPROCESS).
    const b2 = results.events.length;
    win32.activateWindow(own);
    await sleep(500);
    results.checks.ownSkipped = results.events.slice(b2).every((e) => e.hwnd !== own);

    // 3. Handoff from inside the event: notepad comes to front, we take it back.
    handoffTarget = other;
    win32.activateWindow(other);
    await sleep(1000);
    results.checks.handoffForegroundIsOwn = win32.getForegroundWindowHandle() === own;
    handoffTarget = null;
  }

  // 4. After stopping, no more events.
  stop();
  const b4 = results.events.length;
  if (other !== null) {
    win32.activateWindow(other);
    await sleep(500);
  }
  results.checks.noEventsAfterStop = results.events.length === b4;
  results.checks.microtasks = microtasks;
  console.log(JSON.stringify(results, null, 2));
  try { child.kill(); } catch {}
  const ok = results.checks.eventForOther === true && results.checks.noEventsAfterStop === true;
  console.log(ok ? 'PROBE PASS' : 'PROBE FAIL');
  app.exit(ok ? 0 : 1);
});
