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
  let lastLine: string | null = null;
  let generation = 0;

  async function closeIfPaused(): Promise<void> {
    const requestGeneration = generation;
    let paused: boolean | null = null;
    try {
      paused = await deps.getPlaybackPaused();
    } catch {
      return;
    }
    // A newer line or a switch to keyboard-driven mode owns the popup now.
    if (requestGeneration !== generation || deps.isKeyboardDrivenModeEnabled()) return;
    if (paused !== true || !deps.isLookupPopupOpen()) return;
    deps.releasePopupPause();
    deps.closeLookupPopup();
  }

  return {
    handleSubtitleText(text: string): Promise<void> {
      // The tokenized upgrade of a cue trims and normalizes whitespace in the provisional
      // text, so whitespace alone never marks a new line.
      const line = text.replace(/\s+/g, '');
      const previous = lastLine;
      lastLine = line;
      if (previous === null || previous === line) return Promise.resolve();
      generation += 1;
      if (deps.isKeyboardDrivenModeEnabled() || !deps.isLookupPopupOpen()) {
        return Promise.resolve();
      }
      return closeIfPaused();
    },
  };
}
