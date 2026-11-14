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
 * A managed mpv launch that finds SubMiner already running hands its session over with
 * `--start --managed-playback`. The latest such `--start` decides whether closing mpv quits the
 * app, so a tray app started on its own does not linger after a launcher-managed mpv closes.
 */
export function resolveManagedPlaybackAttachment(
  current: boolean,
  args: Pick<CliArgs, 'start' | 'managedPlayback'>,
  source: CliCommandSource,
): boolean {
  if (source !== 'second-instance' || !args.start) return current;
  return args.managedPlayback === true;
}

export function shouldQuitOnMpvShutdownForTrayState(options: {
  managedPlayback: boolean;
  backgroundMode: boolean;
  hasTray: boolean;
}): boolean {
  // managedPlayback marks process ownership; tray/background only affect window-close policy.
  return options.managedPlayback;
}
