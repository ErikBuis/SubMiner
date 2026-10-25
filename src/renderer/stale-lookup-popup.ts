// A seek replaces the subtitle line a dictionary lookup was opened from, but the popup
// keeps showing the old entry. Playback is paused while that happens (the popup pauses
// it, or the user did), so a line change while paused means the user moved away from
// the looked-up word: close the popup and leave playback paused.
//
// Line changes during playback keep the popup open so users without popup auto-pause
// can keep reading. Keyboard-driven mode reopens its lookup on the new line itself.
export function createStaleLookupPopupCloser(deps: {
  isKeyboardDrivenModeEnabled: () => boolean;
  isLookupPopupOpen: () => boolean;
  getPlaybackPaused: () => Promise<boolean | null>;
  // Hands a popup-owned pause to the user so closing the popup does not resume playback.
  releasePopupPause: () => void;
  closeLookupPopup: () => void;
}) {
  let lastText: string | null = null;

  async function closeIfPaused(): Promise<void> {
    let paused: boolean | null = null;
    try {
      paused = await deps.getPlaybackPaused();
    } catch {
      return;
    }
    if (paused !== true || !deps.isLookupPopupOpen()) return;
    deps.releasePopupPause();
    deps.closeLookupPopup();
  }

  return {
    handleSubtitleText(text: string): Promise<void> {
      const previous = lastText;
      lastText = text;
      if (previous === null || previous === text) return Promise.resolve();
      if (deps.isKeyboardDrivenModeEnabled() || !deps.isLookupPopupOpen()) {
        return Promise.resolve();
      }
      return closeIfPaused();
    },
  };
}
