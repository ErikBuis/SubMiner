type MpvVisibilityClient = {
  connected: boolean;
  requestProperty: (name: string) => Promise<unknown>;
};

type RestoreOverlayMpvSubtitlesOptions = {
  force?: boolean;
};

function parseSubVisibility(value: unknown): boolean {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'no' || normalized === 'false' || normalized === '0') {
      return false;
    }
    if (normalized === 'yes' || normalized === 'true' || normalized === '1') {
      return true;
    }
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  return true;
}

// The mpv plugin shows mpv's subtitles while the overlay loads and keeps the visibility
// from before that here, so restoring it doesn't turn on subtitles the user had hidden.
export const SUB_VISIBILITY_BEFORE_OVERLAY_PROPERTY =
  'user-data/subminer/sub-visibility-before-overlay';

function readSubVisibilityBeforeOverlay(mpvClient: MpvVisibilityClient): Promise<unknown> {
  // Both reads go out before any visibility write so neither sees the overlay's own change.
  const beforeOverlay = mpvClient
    .requestProperty(SUB_VISIBILITY_BEFORE_OVERLAY_PROPERTY)
    .catch(() => null);
  const current = mpvClient.requestProperty('sub-visibility');
  current.catch(() => {});
  return beforeOverlay.then((value) => (typeof value === 'boolean' ? value : current));
}

export function createEnsureOverlayMpvSubtitlesHiddenHandler(deps: {
  getMpvClient: () => MpvVisibilityClient | null;
  getSavedSubVisibility: () => boolean | null;
  setSavedSubVisibility: (visible: boolean | null) => void;
  getRevision: () => number;
  setRevision: (revision: number) => void;
  setMpvSubVisibility: (visible: boolean) => void;
  // While the overlay window is still loading it can't draw subtitles yet, so mpv keeps
  // showing its own until the overlay takes over.
  isOverlayContentReady?: () => boolean;
  logWarn: (message: string, error: unknown) => void;
}) {
  // Overlapping calls (show, readiness and toggle callbacks) share one capture, so a later
  // call can't read back an earlier call's visibility write as the user's setting.
  let pendingCapture: Promise<boolean> | null = null;
  let latestEnsureRevision = deps.getRevision();

  return async (): Promise<void> => {
    // Anything else that moved the revision (a restore) ended the previous cycle.
    if (deps.getRevision() !== latestEnsureRevision) {
      pendingCapture = null;
    }
    const revision = deps.getRevision() + 1;
    deps.setRevision(revision);
    latestEnsureRevision = revision;

    const mpvClient = deps.getMpvClient();
    if (!mpvClient || !mpvClient.connected) {
      return;
    }

    let capture: Promise<boolean> | null = null;
    if (deps.getSavedSubVisibility() === null) {
      if (!pendingCapture) {
        const started = readSubVisibilityBeforeOverlay(mpvClient).then(
          parseSubVisibility,
          (error: unknown) => {
            deps.logWarn(
              '[overlay] Failed to capture mpv sub-visibility; falling back to visible restore',
              error,
            );
            return true;
          },
        );
        pendingCapture = started;
        void started.then(() => {
          if (pendingCapture === started) pendingCapture = null;
        });
      }
      capture = pendingCapture;
    }

    // Hide immediately on overlay toggle; capture/restore logic is handled separately.
    const showWhileOverlayLoads = deps.isOverlayContentReady?.() === false;
    if (!showWhileOverlayLoads) {
      deps.setMpvSubVisibility(false);
    }

    if (capture) {
      const capturedVisibility = await capture;
      // Only the newest call commits: a newer one shares this capture or, after a restore,
      // started its own.
      if (revision !== deps.getRevision()) {
        return;
      }
      if (deps.getSavedSubVisibility() === null) {
        deps.setSavedSubVisibility(capturedVisibility);
      }
    }

    // Showing mpv's subtitles waits for the capture: an overlapping call would otherwise
    // read back this write instead of the user's own visibility.
    if (showWhileOverlayLoads && revision === deps.getRevision()) {
      deps.setMpvSubVisibility(true);
    }
  };
}

export function createRestoreOverlayMpvSubtitlesHandler(deps: {
  getSavedSubVisibility: () => boolean | null;
  setSavedSubVisibility: (visible: boolean | null) => void;
  getRevision: () => number;
  setRevision: (revision: number) => void;
  isMpvConnected: () => boolean;
  shouldKeepSuppressedFromVisibleOverlayBinding: () => boolean;
  setMpvSubVisibility: (visible: boolean) => void;
  isOverlayContentReady?: () => boolean;
  // Tells the mpv plugin the visibility it saved before the loading fallback is used up.
  onSubVisibilityRestored?: () => void;
}) {
  return (options: RestoreOverlayMpvSubtitlesOptions = {}): void => {
    const savedVisibility = deps.getSavedSubVisibility();
    // Still suppressed, so the cycle and any capture in flight stay valid.
    if (!options.force && deps.shouldKeepSuppressedFromVisibleOverlayBinding()) {
      const overlayLoading = deps.isOverlayContentReady?.() === false;
      // Showing mpv's subtitles before their visibility was captured would make the
      // fallback look like the user's own setting; the next ensure call shows them.
      if (!overlayLoading || savedVisibility !== null) {
        deps.setMpvSubVisibility(overlayLoading);
      }
      return;
    }

    deps.setRevision(deps.getRevision() + 1);

    if (savedVisibility === null) {
      // Quitting before the capture finished: the plugin still ends its loading fallback.
      if (options.force) {
        deps.onSubVisibilityRestored?.();
      }
      return;
    }

    if (!deps.isMpvConnected()) {
      return;
    }

    if (savedVisibility !== null) {
      deps.setMpvSubVisibility(savedVisibility);
      deps.onSubVisibilityRestored?.();
    }

    deps.setSavedSubVisibility(null);
  };
}
