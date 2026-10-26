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
  return async (): Promise<void> => {
    const revision = deps.getRevision() + 1;
    deps.setRevision(revision);

    const mpvClient = deps.getMpvClient();
    if (!mpvClient || !mpvClient.connected) {
      return;
    }

    const shouldCaptureSavedVisibility = deps.getSavedSubVisibility() === null;
    const savedVisibilityPromise = shouldCaptureSavedVisibility
      ? readSubVisibilityBeforeOverlay(mpvClient)
      : null;

    // Hide immediately on overlay toggle; capture/restore logic is handled separately.
    const showWhileOverlayLoads = deps.isOverlayContentReady?.() === false;
    if (!showWhileOverlayLoads) {
      deps.setMpvSubVisibility(false);
    }

    if (shouldCaptureSavedVisibility && savedVisibilityPromise) {
      try {
        const currentSubVisibility = await savedVisibilityPromise;
        if (revision !== deps.getRevision()) {
          return;
        }
        deps.setSavedSubVisibility(parseSubVisibility(currentSubVisibility));
      } catch (error) {
        if (revision !== deps.getRevision()) {
          return;
        }
        deps.logWarn(
          '[overlay] Failed to capture mpv sub-visibility; falling back to visible restore',
          error,
        );
        deps.setSavedSubVisibility(true);
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
}) {
  return (options: RestoreOverlayMpvSubtitlesOptions = {}): void => {
    deps.setRevision(deps.getRevision() + 1);

    const savedVisibility = deps.getSavedSubVisibility();
    if (!options.force && deps.shouldKeepSuppressedFromVisibleOverlayBinding()) {
      deps.setMpvSubVisibility(deps.isOverlayContentReady?.() === false);
      return;
    }

    if (savedVisibility === null) {
      return;
    }

    if (!deps.isMpvConnected()) {
      return;
    }

    if (savedVisibility !== null) {
      deps.setMpvSubVisibility(savedVisibility);
    }

    deps.setSavedSubVisibility(null);
  };
}
