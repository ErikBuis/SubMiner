import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import {
  buildMpvInputLockCommands,
  buildMpvInputUnlockCommands,
} from '../src/core/services/mpv-input-lock';
import { generateFixtureClip, writeFixtureSubtitles } from './harness/fixtures';
import { connectMpv, type MpvClient } from './harness/mpv';
import { stopProcess } from './harness/process';
import { waitUntil } from './harness/wait';

// The app's input lock against a real mpv running SubMiner's real mpv plugin, without the app:
// the test sends the lock commands the app sends and presses keys over IPC, which mpv handles
// exactly like keys from its window.

const TEST_TIMEOUT_MS = 60_000;
const repoRoot = path.resolve(__dirname, '..');

// Stands in for other mpv scripts (forced and normal bindings, and one that changes its
// bindings while the lock is held) and for the app answering the lock's blocked-key report.
const PROBE_SCRIPT = `
local hits = {}
local function hit(name)
  return function()
    hits[name] = (hits[name] or 0) + 1
    mp.set_property_native("user-data/probe/hits", hits)
  end
end
mp.add_forced_key_binding("j", "probe-forced-j", hit("forced-j"))
mp.add_key_binding("k", "probe-plain-k", hit("plain-k"))
mp.register_script_message("probe-rebind", function()
  mp.add_forced_key_binding("h", "probe-forced-h", hit("forced-h"))
  mp.set_property_native("user-data/probe/rebound", true)
end)

local app_alive = true
local blocked = 0
mp.register_script_message("subminer-input-lock-blocked-key", function()
  blocked = blocked + 1
  mp.set_property_native("user-data/probe/blocked", blocked)
  if app_alive then
    mp.commandv("script-message", "subminer-input-lock", "on")
  end
end)
mp.register_script_message("probe-app-gone", function()
  app_alive = false
  mp.set_property_native("user-data/probe/app-gone", true)
end)
`;

// Every key and button here changes something in mpv's default bindings or a probe binding.
const BLOCKED_KEYS = [
  'SPACE', // cycle pause
  'p', // cycle pause
  'RIGHT', // seek 5
  '9', // add volume -2
  'm', // cycle mute
  'z', // add sub-delay -0.1
  'x', // add sub-delay +0.1
  '[', // multiply speed 1/1.1
  'j', // probe's forced binding (default: cycle sub)
  'k', // probe's normal binding
  's', // screenshot
  'q', // quit
  'MBTN_RIGHT', // cycle pause
  'WHEEL_UP', // add volume 2
];

const WATCHED_PROPERTIES = [
  'pause',
  'time-pos',
  'volume',
  'mute',
  'sub-delay',
  'sid',
  'speed',
  'user-data/probe/hits',
];

// Loads the real plugin from the repo. mpv before 0.38 (Ubuntu 24.04's, which CI installs) has
// no `mp.input`; the plugin only needs it for its menus, so a stub stands in there.
function pluginLoaderScript(pluginDir: string): string {
  return `
if not pcall(require, "mp.input") then
  package.preload["mp.input"] = function() return {} end
end
local plugin_dir = ${JSON.stringify(pluginDir)}
package.path = plugin_dir .. "/?.lua;" .. plugin_dir .. "/?/init.lua;" .. package.path
assert(loadfile(plugin_dir .. "/init.lua"))().init()
`;
}

type Started = { mpv: MpvClient; child: ChildProcess; root: string; screenshotDir: string };
let started: Promise<Started> | undefined;

function useMpv(): Promise<Started> {
  started ??= (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subminer-input-lock-'));
    const mediaPath = path.join(root, 'clip.mkv');
    const subtitlePath = path.join(root, 'clip.srt');
    const probePath = path.join(root, 'probe.lua');
    const screenshotDir = path.join(root, 'screenshots');
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\${path.basename(root)}-mpv`
        : path.join(root, 'mpv.sock');
    // The script directory's name is the plugin's script name, which its options are keyed by.
    const pluginLoaderDir = path.join(root, 'scripts', 'subminer');
    fs.mkdirSync(screenshotDir);
    fs.mkdirSync(pluginLoaderDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginLoaderDir, 'main.lua'),
      pluginLoaderScript(path.join(repoRoot, 'plugin', 'subminer')),
    );
    fs.writeFileSync(probePath, PROBE_SCRIPT);
    writeFixtureSubtitles(subtitlePath);
    await generateFixtureClip(mediaPath);

    const log = fs.openSync(path.join(root, 'mpv-stdio.log'), 'w');
    const child = spawn(
      'mpv',
      [
        '--no-config',
        '--no-terminal',
        `--log-file=${path.join(root, 'mpv.log')}`,
        '--pause',
        '--keep-open=yes',
        '--vo=null',
        '--ao=null',
        `--screenshot-dir=${screenshotDir}`,
        `--script=${pluginLoaderDir}`,
        `--script=${probePath}`,
        '--script-opts=subminer-auto_start=no,subminer-osd_messages=no',
        `--input-ipc-server=${socketPath}`,
        `--sub-file=${subtitlePath}`,
        mediaPath,
      ],
      { stdio: ['ignore', log, log] },
    );
    fs.closeSync(log);
    await once(child, 'spawn');
    const mpv = await connectMpv(socketPath, () => `mpv exited (${String(child.exitCode)})`);
    // `duration` is unavailable (an error, not null) until the file has loaded.
    await waitUntil(() => mpv.command('get_property', 'duration').catch(() => null), {
      description: 'mpv to load the clip',
      timeoutMs: 20_000,
    });
    await mpv.command('seek', 5, 'absolute+exact');
    return { mpv, child, root, screenshotDir };
  })();
  return started;
}

after(async () => {
  const running = await started?.catch(() => undefined);
  if (!running) return;
  running.mpv.close();
  await stopProcess(running.child);
  if (process.env.SUBMINER_E2E_KEEP !== '1') {
    fs.rmSync(running.root, { recursive: true, force: true });
  }
});

/** A probe value, or null until the probe has set it (mpv reports a missing one as an error). */
function readProbe(mpv: MpvClient, name: string): Promise<unknown> {
  return mpv.command('get_property', `user-data/probe/${name}`).catch(() => null);
}

async function snapshot(mpv: MpvClient): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const name of WATCHED_PROPERTIES) {
    values[name] = await mpv.command('get_property', name).catch(() => null);
  }
  return values;
}

async function press(mpv: MpvClient, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    await mpv.command('keypress', key);
  }
  // keypress returns once the key is queued; a round trip later mpv has run its binding.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await mpv.command('get_property', 'pause');
}

async function lock(mpv: MpvClient): Promise<void> {
  for (const command of buildMpvInputLockCommands()) await mpv.command(...command);
}

async function unlock(mpv: MpvClient): Promise<void> {
  for (const command of buildMpvInputUnlockCommands()) await mpv.command(...command);
}

test(
  'the input lock blocks mpv keys, mouse buttons, and script bindings until released',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { mpv, child, screenshotDir } = await useMpv();
    await lock(mpv);
    const before = await snapshot(mpv);
    assert.equal(before.pause, true);
    assert.equal(before.sid, 1);

    await press(mpv, BLOCKED_KEYS);

    assert.equal(child.exitCode, null, 'q must not quit mpv while locked');
    assert.deepEqual(await snapshot(mpv), before);
    assert.deepEqual(fs.readdirSync(screenshotDir), [], 's must not take a screenshot');
    // Every key went to the lock instead, and each report got the stand-in app's answer.
    assert.equal(await mpv.command('get_property', 'user-data/probe/blocked'), BLOCKED_KEYS.length);

    await unlock(mpv);
    await press(mpv, ['9', 'k']);
    const released = await snapshot(mpv);
    assert.equal(released.volume, (before.volume as number) - 2, 'keys work again once released');
    assert.deepEqual(released['user-data/probe/hits'], { 'plain-k': 1 });
  },
);

test(
  'the plugin keeps the lock above a script that changes its bindings while locked',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { mpv } = await useMpv();
    await lock(mpv);
    // Changing bindings re-enables the probe's sections on top of the lock.
    await mpv.command('script-message', 'probe-rebind');
    await waitUntil(async () => (await readProbe(mpv, 'rebound')) === true, {
      description: 'the probe to change its bindings',
    });
    // The plugin puts the lock back on top within its keep-on-top interval.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const before = await snapshot(mpv);

    await press(mpv, ['h', 'j', 'k', 'SPACE']);

    assert.deepEqual(await snapshot(mpv), before);
    await unlock(mpv);
  },
);

test(
  'the plugin releases the lock when the app stops answering, and the close button still quits',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { mpv, child } = await useMpv();
    await lock(mpv);
    await mpv.command('script-message', 'probe-app-gone');
    await waitUntil(async () => (await readProbe(mpv, 'app-gone')) === true, {
      description: 'the stand-in app to stop answering',
    });
    const volume = (await mpv.command('get_property', 'volume')) as number;

    await press(mpv, ['9']);
    assert.equal(await mpv.command('get_property', 'volume'), volume, 'still locked at first');

    // No answer to the blocked key: after its timeout the plugin gives mpv its keys back.
    await waitUntil(
      async () => {
        await press(mpv, ['9']);
        return ((await mpv.command('get_property', 'volume')) as number) < volume;
      },
      { description: 'the plugin to release an unanswered lock', timeoutMs: 10_000 },
    );

    // The window's close button quits mpv even while locked.
    await lock(mpv);
    await press(mpv, ['9']);
    assert.equal(child.exitCode, null);
    await mpv.command('keypress', 'CLOSE_WIN').catch(() => undefined);
    await waitUntil(() => child.exitCode !== null, {
      description: 'the close button to quit a locked mpv',
    });
  },
);
