// Throwaway Windows probe: are EVENT_OBJECT_LOCATIONCHANGE events for another process delivered
// on Electron's main thread through koffi while that process moves its window, and can the
// callback move a BrowserWindow along with it?
const { app, BrowserWindow, screen } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const win32 = require(path.resolve(__dirname, '../../probe-out/win32.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const checks = {};
  const follower = new BrowserWindow({ width: 300, height: 200, show: true, frame: false });
  await follower.loadURL('data:text/html,<h1>follower</h1>');

  const child = spawn('notepad.exe', [], { detached: false });
  await sleep(2500);
  const found = win32.findMpvWindows(child.pid);
  const target = found.matches[0]?.hwnd ?? null;
  console.log('notepad pid', child.pid, 'hwnd', target);
  if (target === null) {
    console.log('PROBE FAIL: no notepad window');
    app.exit(1);
    return;
  }

  const events = [];
  let microtasks = 0;
  let callbackErrors = 0;
  const stop = win32.watchProcessWindowLocation(child.pid, (hwnd) => {
    try {
      const at = Date.now();
      const bounds = hwnd === target ? win32.getVisibleWindowBounds(hwnd) : null;
      events.push({ hwnd, at, bounds });
      if (bounds) follower.setBounds(screen.screenToDipRect(null, bounds));
      Promise.resolve().then(() => microtasks++);
    } catch (error) {
      callbackErrors++;
      console.log('callback error', error);
    }
  });

  // Another process moves notepad 60 times, about one step per frame, like a title-bar drag.
  const ps = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); }
"@
$sw = [Diagnostics.Stopwatch]::StartNew()
for ($i = 0; $i -lt 60; $i++) { [W]::SetWindowPos([IntPtr]${target}, [IntPtr]::Zero, 100 + $i * 5, 100 + $i * 2, 0, 0, 0x0015) | Out-Null; Start-Sleep -Milliseconds 16 }
Write-Output "moved in $($sw.ElapsedMilliseconds) ms"
`;
  const mover = spawn('powershell.exe', ['-NoProfile', '-Command', ps]);
  mover.stdout.on('data', (d) => console.log('mover:', String(d).trim()));
  mover.stderr.on('data', (d) => console.log('mover err:', String(d).trim()));
  const moveStart = Date.now();
  await new Promise((r) => mover.on('exit', r));
  await sleep(300);

  const targetEvents = events.filter((e) => e.hwnd === target && e.bounds);
  checks.targetEvents = targetEvents.length;
  checks.otherEvents = events.length - targetEvents.length;
  checks.callbackErrors = callbackErrors;
  checks.microtasks = microtasks;
  const finalTarget = win32.getVisibleWindowBounds(target);
  const followerDip = follower.getBounds();
  const expectedDip = screen.screenToDipRect(null, finalTarget);
  checks.finalTarget = finalTarget;
  checks.followerMatches =
    followerDip.x === expectedDip.x &&
    followerDip.y === expectedDip.y &&
    followerDip.width === expectedDip.width &&
    followerDip.height === expectedDip.height;
  if (targetEvents.length > 1) {
    const gaps = targetEvents.slice(1).map((e, i) => e.at - targetEvents[i].at);
    checks.maxGapMs = Math.max(...gaps);
    checks.firstEventAfterMoveStartMs = targetEvents[0].at - moveStart;
  }

  stop();
  const before = events.length;
  const ps2 = `Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f); }
"@
[W]::SetWindowPos([IntPtr]${target}, [IntPtr]::Zero, 20, 20, 0, 0, 0x0015) | Out-Null`;
  await new Promise((r) => spawn('powershell.exe', ['-NoProfile', '-Command', ps2]).on('exit', r));
  await sleep(300);
  checks.noEventsAfterStop = events.length === before;

  console.log(JSON.stringify(checks, null, 2));
  try {
    child.kill();
  } catch {}
  const ok =
    checks.targetEvents >= 50 &&
    checks.callbackErrors === 0 &&
    checks.followerMatches &&
    checks.noEventsAfterStop;
  console.log(ok ? 'PROBE PASS' : 'PROBE FAIL');
  app.exit(ok ? 0 : 1);
});
