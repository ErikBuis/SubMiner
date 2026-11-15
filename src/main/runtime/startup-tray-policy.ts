import type { CliArgs, CliCommandSource } from '../../cli/args';

export function shouldEnsureTrayOnStartupForInitialArgs(
  platform: NodeJS.Platform,
  initialArgs: CliArgs | null,
): boolean {
  if (platform !== 'win32') {
    return false;
  }
  if (initialArgs?.youtubePlay) {
    return false;
  }
  return true;
}

export function shouldQuitOnWindowAllClosedForTrayState(options: {
  backgroundMode: boolean;
  hasTray: boolean;
}): boolean {
  if (options.backgroundMode) return false;
  if (options.hasTray) return false;
  return true;
}

/**
 * When the Windows mpv launcher finds SubMiner already running, it hands its mpv over with
 * `--start --quit-with-mpv`. From then on, closing mpv quits the app, just like when the launcher
 * started the app itself. Other commands (including the mpv plugin's own `--start` handoff to a
 * tray app the user started) leave this unchanged.
 */
export function resolveManagedPlaybackAttachment(
  current: boolean,
  args: Pick<CliArgs, 'start' | 'quitWithMpv'>,
  source: CliCommandSource,
): boolean {
  if (source === 'second-instance' && args.start && args.quitWithMpv) return true;
  return current;
}

export function shouldQuitOnMpvShutdownForTrayState(options: {
  managedPlayback: boolean;
  backgroundMode: boolean;
  hasTray: boolean;
}): boolean {
  // managedPlayback marks process ownership; tray/background only affect window-close policy.
  return options.managedPlayback;
}
