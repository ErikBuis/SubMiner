import type { RendererDom } from '../utils/dom';

type ButtonDomKey = {
  [Key in keyof RendererDom]: RendererDom[Key] extends HTMLButtonElement ? Key : never;
}[keyof RendererDom];

export interface MediaTimingReviewButtonHotkey {
  /** What the button does, as the start of its tooltip. */
  action: string;
  /** The keys as the user presses them, e.g. `Shift+P`. */
  keys: string;
}

/**
 * The keyboard shortcut of each card review button that has one, shown as the button's
 * tooltip. Buttons without a shortcut are left out and keep their own title (if any).
 * Keep this in step with `handleMediaTimingReviewKeydown`, which handles the keys.
 */
export const MEDIA_TIMING_REVIEW_BUTTON_HOTKEYS: Partial<
  Record<ButtonDomKey, MediaTimingReviewButtonHotkey>
> = {
  mediaTimingReviewPlay: { action: 'Play or stop the selection', keys: 'Space' },
  mediaTimingReviewConfirm: { action: 'Export the card', keys: 'Enter' },
  mediaTimingReviewCancel: { action: 'Stop reviewing', keys: 'Esc' },
  mediaTimingReviewCancelBack: { action: 'Go back to the review', keys: 'Esc' },
  mediaTimingReviewPrevAdd: { action: 'Add the previous line', keys: 'P' },
  mediaTimingReviewPrevRemove: { action: 'Remove the earliest previous line', keys: 'Shift+P' },
  mediaTimingReviewNextAdd: { action: 'Add the next line', keys: 'N' },
  mediaTimingReviewNextRemove: { action: 'Remove the latest next line', keys: 'Shift+N' },
};

export function formatMediaTimingReviewHotkeyTooltip(
  hotkey: MediaTimingReviewButtonHotkey,
): string {
  return `${hotkey.action} (${hotkey.keys})`;
}

/** Gives every review button with a shortcut a tooltip that names it. */
export function applyMediaTimingReviewHotkeyTooltips(dom: Pick<RendererDom, ButtonDomKey>): void {
  for (const [domKey, hotkey] of Object.entries(MEDIA_TIMING_REVIEW_BUTTON_HOTKEYS) as Array<
    [ButtonDomKey, MediaTimingReviewButtonHotkey]
  >) {
    dom[domKey].title = formatMediaTimingReviewHotkeyTooltip(hotkey);
  }
}
