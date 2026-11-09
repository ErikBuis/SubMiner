import { createMediaTimingFramePicker } from './media-timing-frame-picker';
import type {
  MediaTimingReviewContextLine,
  MediaTimingReviewDecision,
  MediaTimingReviewLineTranslation,
  MediaTimingReviewOpenPayload,
  MediaTimingReviewPreviewPosition,
} from '../../types/anki';
import type { ModalStateReader, RendererContext } from '../context';
import type {
  MediaTimingReviewControllerAction,
  MediaTimingReviewStep,
} from '../handlers/media-timing-review-controller.js';
import type { RendererDom } from '../utils/dom';
import { createModalFocusGuard } from './modal-focus-guard';
import {
  findBestOverlappingLine,
  isSourceLanguageText,
  formatCardTranslation,
  joinSubtitleLineTexts,
} from '../../shared/sentence-translation-alignment';

const MINIMUM_CLIP_SECONDS = 0.1;
const FINE_ADJUST_SECONDS = 0.1;
const COARSE_ADJUST_SECONDS = 0.5;
/** The outer buttons of each edge's group (−2.0s / +2.0s). */
const JUMP_ADJUST_SECONDS = 2;
/** How long a nudged edge stays highlighted after the last nudge. */
const EDGE_HIGHLIGHT_MS = 700;
const LINE_REVEAL_MARGIN_SECONDS = 1;
/**
 * Subtitles usually linger past the dialogue for readability, so an untouched clip end
 * follows the last speech-weighted waveform slice above this level (0..1, relative to the
 * clip's own noise floor) plus a short tail, when that saves at least the minimum trim.
 */
const SPEECH_LEVEL_THRESHOLD = 0.3;
const SPEECH_TAIL_SECONDS = 0.15;
const MINIMUM_TRAILING_TRIM_SECONDS = 0.1;
/** Allow buffering and output-device delays without cutting off an advancing preview. */
const PREVIEW_STALL_TIMEOUT_MS = 15_000;

type ButtonDomKey = {
  [Key in keyof RendererDom]: RendererDom[Key] extends HTMLButtonElement ? Key : never;
}[keyof RendererDom];

/** The on-screen button each controller action presses. */
export const MEDIA_TIMING_REVIEW_CONTROLLER_BUTTONS: Record<
  MediaTimingReviewControllerAction,
  ButtonDomKey
> = {
  confirm: 'mediaTimingReviewConfirm',
  cancel: 'mediaTimingReviewCancel',
  play: 'mediaTimingReviewPlay',
  resetTiming: 'mediaTimingReviewReset',
  startBack: 'mediaTimingReviewStartBack',
  startForward: 'mediaTimingReviewStartForward',
  startBackCoarse: 'mediaTimingReviewStartBackCoarse',
  startForwardCoarse: 'mediaTimingReviewStartForwardCoarse',
  endBack: 'mediaTimingReviewEndBack',
  endForward: 'mediaTimingReviewEndForward',
  endBackCoarse: 'mediaTimingReviewEndBackCoarse',
  endForwardCoarse: 'mediaTimingReviewEndForwardCoarse',
  previousLineAdd: 'mediaTimingReviewPrevAdd',
  previousLineRemove: 'mediaTimingReviewPrevRemove',
  nextLineAdd: 'mediaTimingReviewNextAdd',
  nextLineRemove: 'mediaTimingReviewNextRemove',
  framePrevious: 'mediaTimingReviewFramePrevious',
  frameNext: 'mediaTimingReviewFrameNext',
  frameReset: 'mediaTimingReviewFrameReset',
  keepEditing: 'mediaTimingReviewCancelBack',
  discard: 'mediaTimingReviewDiscard',
};

const FOCUSABLE_SELECTOR = 'button, input, textarea, select, [tabindex]:not([tabindex="-1"])';

/**
 * The controls Tab and the arrow keys can reach on the visible step of the review, in
 * document order. The edge handles and the screenshot slider are mouse-only
 * (tabindex -1): the nudge and frame buttons do the same from the keyboard.
 */
export function listMediaTimingReviewFocusTargets(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !(element as HTMLButtonElement).disabled &&
      element.closest('.hidden, [inert]') === null &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden',
  );
}

/**
 * Where Tab or Shift+Tab should go so focus wraps around the dialog instead of leaving
 * it. Null means the browser's own move already stays inside.
 */
export function wrapMediaTimingReviewFocus(
  targets: readonly HTMLElement[],
  active: Element | null,
  backwards: boolean,
): HTMLElement | null {
  if (targets.length === 0) return null;
  const first = targets[0]!;
  const last = targets[targets.length - 1]!;
  const index = active === null ? -1 : targets.indexOf(active as HTMLElement);
  if (index === -1) return backwards ? last : first;
  if (backwards && active === first) return last;
  if (!backwards && active === last) return first;
  return null;
}

/**
 * Whether focus sits on something inside the dialog. The dialog root itself does not
 * count: a click on plain text focuses it, and keys then start from the first or last
 * control as if focus were outside.
 */
export function isMediaTimingReviewFocusInside(
  modal: Pick<Node, 'contains'>,
  active: Node | null,
): boolean {
  return active !== null && active !== modal && modal.contains(active);
}

export type MediaTimingReviewArrowDirection = 'up' | 'down' | 'left' | 'right';

export type MediaTimingReviewBox = { left: number; top: number; right: number; bottom: number };

export function mediaTimingReviewArrowDirection(
  key: string,
): MediaTimingReviewArrowDirection | null {
  switch (key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    default:
      return null;
  }
}

/** How far a vertical move may stray sideways, relative to how far it goes down or up. */
const ARROW_SIDEWAYS_WEIGHT = 2;
/** Boxes may overlap this much and still count as lying past each other. */
const ARROW_OVERLAP_TOLERANCE_PX = 2;

/**
 * Index of the control an arrow key moves to from the box `from`, by where the controls
 * sit on screen, or -1 when nothing lies that way. Left and right stay on the same row.
 * Up and down take the control past `from` that is closest, counting sideways distance
 * double, so a control straight above or below wins over a nearer one off to the side.
 */
export function pickMediaTimingReviewArrowTarget(
  from: MediaTimingReviewBox,
  candidates: readonly MediaTimingReviewBox[],
  direction: MediaTimingReviewArrowDirection,
  skipIndex = -1,
): number {
  const fromCenterX = (from.left + from.right) / 2;
  const fromCenterY = (from.top + from.bottom) / 2;
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((box, index) => {
    if (index === skipIndex) return;
    const centerX = (box.left + box.right) / 2;
    const centerY = (box.top + box.bottom) / 2;
    let score: number;
    if (direction === 'left' || direction === 'right') {
      const sameRow = box.top < from.bottom && box.bottom > from.top;
      const ahead = direction === 'right' ? centerX - fromCenterX : fromCenterX - centerX;
      if (!sameRow || ahead <= 0) return;
      score = ahead + Math.abs(centerY - fromCenterY);
    } else {
      const ahead = direction === 'down' ? box.top - from.bottom : from.top - box.bottom;
      if (ahead < -ARROW_OVERLAP_TOLERANCE_PX) return;
      const sideways = Math.max(0, box.left - from.right, from.left - box.right);
      // The center distance only breaks ties between controls that all line up.
      score =
        Math.max(0, ahead) +
        ARROW_SIDEWAYS_WEIGHT * sideways +
        Math.abs(centerX - fromCenterX) / 100;
    }
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  });
  return best;
}

/** A controller press only counts when a mouse click could have reached the button. */
export function isMediaTimingReviewButtonAvailable(button: HTMLButtonElement): boolean {
  return !button.disabled && button.closest('.hidden') === null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function formatMediaTimingTimestamp(seconds: number, includeMilliseconds = true): string {
  const unitsPerSecond = includeMilliseconds ? 1_000 : 1;
  const totalUnits = Math.max(0, Math.round(seconds * unitsPerSecond));
  const unitsPerMinute = 60 * unitsPerSecond;
  const minutes = Math.floor(totalUnits / unitsPerMinute);
  const remainingUnits = totalUnits % unitsPerMinute;
  const remaining = includeMilliseconds
    ? (remainingUnits / unitsPerSecond).toFixed(3)
    : String(remainingUnits);
  return `${String(minutes).padStart(2, '0')}:${remaining.padStart(includeMilliseconds ? 6 : 2, '0')}`;
}

/**
 * Resolves which subtitle lines the card sentence currently includes. The counts say
 * how many adjacent lines were pulled in on each side; the range covers those lines'
 * subtitle timings so the clip edges can follow them.
 */
export function buildMediaTimingLineSelection(options: {
  previousLines: MediaTimingReviewContextLine[];
  nextLines: MediaTimingReviewContextLine[];
  text: string;
  originalStartTime: number;
  originalEndTime: number;
  previousCount: number;
  nextCount: number;
}): {
  previous: MediaTimingReviewContextLine[];
  next: MediaTimingReviewContextLine[];
  lineTexts: string[];
  currentLineIndex: number;
  sentence: string;
  rangeStart: number;
  rangeEnd: number;
} {
  const previous =
    options.previousCount > 0 ? options.previousLines.slice(-options.previousCount) : [];
  const next = options.nextCount > 0 ? options.nextLines.slice(0, options.nextCount) : [];
  const lineTexts = [
    ...previous.map((line) => line.text),
    options.text,
    ...next.map((line) => line.text),
  ];
  return {
    previous,
    next,
    lineTexts,
    currentLineIndex: previous.length,
    sentence: lineTexts.join(' '),
    rangeStart: previous[0]?.startTime ?? options.originalStartTime,
    // The latest end, not the last cue's: an earlier added cue can run longer.
    rangeEnd: Math.max(options.originalEndTime, ...next.map((line) => line.endTime)),
  };
}

/**
 * Puts a subtitle line the review added in front of (previous) or after (next) a sentence
 * the user typed, or takes a removed one out again. A removed line only goes while the
 * typed sentence still starts or ends with it, so text the user rewrote stays as typed.
 */
export function applySentenceLineChange(options: {
  text: string;
  line: string;
  side: 'previous' | 'next';
  added: boolean;
}): string {
  const text = options.text.trim();
  const line = options.line.trim();
  if (!line) return options.text;
  if (options.added) {
    if (!text) return line;
    return options.side === 'previous' ? `${line} ${text}` : `${text} ${line}`;
  }
  if (options.side === 'previous') {
    return text.startsWith(line) ? text.slice(line.length).trimStart() : options.text;
  }
  return text.endsWith(line) ? text.slice(0, text.length - line.length).trimEnd() : options.text;
}

/** Sentences that only differ in spacing are the same sentence on the card. */
function sameSentence(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

function dedupeSortedLines(
  lines: readonly MediaTimingReviewContextLine[],
): MediaTimingReviewContextLine[] {
  const seen = new Set<string>();
  return lines
    .filter((line) => {
      const key = `${line.startTime}|${line.endTime}|${line.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

/**
 * The translation for the lines currently on the card. With no added lines it is the
 * translation main resolved for the card; otherwise added lines bring the translation
 * main's sentence grouping assigned them. Null when there are no secondary lines to follow.
 */
function compactText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '');
}

export function buildMediaTimingReviewTranslation(options: {
  previousLines: MediaTimingReviewContextLine[];
  nextLines: MediaTimingReviewContextLine[];
  text: string;
  originalStartTime: number;
  originalEndTime: number;
  previousCount: number;
  nextCount: number;
  initialTranslation: string;
  /** The secondary lines behind `initialTranslation`; empty when it came from the screen. */
  initialTranslationLines: MediaTimingReviewContextLine[];
  translationLines: MediaTimingReviewContextLine[];
  /** The secondary lines main's sentence grouping assigns each nearby primary line. */
  lineTranslations?: MediaTimingReviewLineTranslation[];
  format: boolean;
}): string | null {
  if (options.previousCount <= 0 && options.nextCount <= 0) return options.initialTranslation;
  if (options.translationLines.length === 0) return null;
  const selection = buildMediaTimingLineSelection(options);
  // The card's own lines keep the translation main resolved. Added lines take the
  // translation main's full-track grouping assigned them; a line main did not cover falls
  // back to the secondary line it overlaps most.
  const addedTranslation = (line: MediaTimingReviewContextLine): MediaTimingReviewContextLine[] => {
    // Two speakers can share one interval; their text tells them apart.
    const own = compactText(line.text);
    const timed =
      options.lineTranslations?.filter(
        (entry) =>
          Math.abs(entry.startTime - line.startTime) < 0.001 &&
          Math.abs(entry.endTime - line.endTime) < 0.001,
      ) ?? [];
    const assigned =
      timed.find((entry) => entry.text !== undefined && compactText(entry.text) === own) ??
      timed[0];
    const best = assigned ? null : findBestOverlappingLine(options.translationLines, line);
    const candidates = assigned?.lines ?? (best ? [best] : []);
    // A secondary track in the primary language is no translation, as in main.
    return candidates.filter((candidate) => !isSourceLanguageText([candidate.text], line.text));
  };
  const before = selection.previous.flatMap(addedTranslation);
  const after = selection.next.flatMap(addedTranslation);
  // A translation taken from the screen has no timed lines behind it; keep its text.
  const translation =
    options.initialTranslationLines.length > 0
      ? joinSubtitleLineTexts(
          dedupeSortedLines([...before, ...options.initialTranslationLines, ...after]),
        )
      : [
          joinSubtitleLineTexts(dedupeSortedLines(before)),
          options.initialTranslation.trim(),
          joinSubtitleLineTexts(dedupeSortedLines(after)),
        ]
          .filter(Boolean)
          .join(' ');
  return options.format ? formatCardTranslation(translation) : translation;
}

export function createMediaTimingPreviewRequestGuard() {
  let sequence = 0;
  let activeRequestId: number | null = null;

  return {
    begin(): number | null {
      if (activeRequestId !== null) return null;
      sequence += 1;
      activeRequestId = sequence;
      return activeRequestId;
    },
    invalidate(): void {
      sequence += 1;
      activeRequestId = null;
    },
    isCurrent(requestId: number): boolean {
      return requestId === activeRequestId;
    },
    finish(requestId: number): void {
      if (activeRequestId === requestId) activeRequestId = null;
    },
    isInFlight(): boolean {
      return activeRequestId !== null;
    },
  };
}

export function buildMediaTimingWaveformPath(peaks: number[]): string {
  if (peaks.length < 2) return '';
  const points = peaks.map((peak, index) => ({
    x: (index / (peaks.length - 1)) * 1_000,
    amplitude: clamp(Number.isFinite(peak) ? peak : 0, 0, 1) * 44,
  }));
  const upper = points.map(({ x, amplitude }) => `${x.toFixed(2)} ${(50 - amplitude).toFixed(2)}`);
  const lower = [...points]
    .reverse()
    .map(({ x, amplitude }) => `${x.toFixed(2)} ${(50 + amplitude).toFixed(2)}`);
  return `M ${upper.join(' L ')} L ${lower.join(' L ')} Z`;
}

/**
 * Where an untouched clip should end once the waveform is known: just after the line's
 * last speech slice, plus the configured end padding. Null keeps the subtitle timing when
 * no speech shows inside the line, when speech runs through the line end (the subtitle is
 * cutting the audio off, not lingering), or when the saving is too small to matter.
 */
export function trimMediaTimingSelectionEnd(options: {
  peaks: readonly number[];
  timelineStart: number;
  timelineEnd: number;
  lineStart: number;
  lineEnd: number;
  selectionEnd: number;
  endPadSeconds: number;
}): number | null {
  const pointCount = options.peaks.length;
  const span = options.timelineEnd - options.timelineStart;
  if (pointCount < 2 || span <= 0 || options.lineEnd <= options.lineStart) return null;
  // Point i covers [i, i + 1) / pointCount of the timeline (see computeWaveformPeaks).
  const sliceEnd = (index: number): number =>
    options.timelineStart + ((index + 1) / pointCount) * span;
  const firstIndex = Math.max(
    0,
    Math.floor(((options.lineStart - options.timelineStart) / span) * pointCount),
  );
  const lastIndex = Math.min(
    pointCount - 1,
    Math.ceil(((options.lineEnd - options.timelineStart) / span) * pointCount) - 1,
  );
  let lastSpeechIndex = -1;
  for (let index = lastIndex; index >= firstIndex; index -= 1) {
    if ((options.peaks[index] ?? 0) >= SPEECH_LEVEL_THRESHOLD) {
      lastSpeechIndex = index;
      break;
    }
  }
  if (lastSpeechIndex === -1 || lastSpeechIndex >= lastIndex) return null;
  const trimmedEnd = sliceEnd(lastSpeechIndex) + SPEECH_TAIL_SECONDS + options.endPadSeconds;
  if (options.selectionEnd - trimmedEnd < MINIMUM_TRAILING_TRIM_SECONDS) return null;
  return trimmedEnd;
}

export function constrainMediaTimingSelection(options: {
  nextStart: number;
  nextEnd: number;
  currentStart: number;
  timelineStart: number;
  timelineEnd: number;
  mediaEnd: number;
  maxMediaDuration: number;
}): { start: number; end: number } {
  let start = clamp(options.nextStart, options.timelineStart, options.timelineEnd);
  let end = clamp(options.nextEnd, options.timelineStart, options.timelineEnd);
  const startMoved = options.nextStart !== options.currentStart;
  if (end - start < MINIMUM_CLIP_SECONDS) {
    if (startMoved) start = end - MINIMUM_CLIP_SECONDS;
    else end = start + MINIMUM_CLIP_SECONDS;
  }
  if (options.maxMediaDuration > 0 && end - start > options.maxMediaDuration) {
    if (startMoved) start = end - options.maxMediaDuration;
    else end = start + options.maxMediaDuration;
  }
  return {
    start: Math.max(0, start),
    end: Math.min(options.mediaEnd, end),
  };
}

/**
 * The clip and timeline view that Reset timing restores. With added lines the clip is the
 * mined padding around those lines; a clip over the length limit keeps its start.
 */
export function resolveMediaTimingReset(options: {
  linesAdded: boolean;
  lineStart: number;
  lineEnd: number;
  startPadSeconds: number;
  endPadSeconds: number;
  selectionStart: number;
  selectionEnd: number;
  timelineStart: number;
  timelineEnd: number;
  mediaEnd: number;
  maxMediaDuration: number;
}): { start: number; end: number; timelineStart: number; timelineEnd: number } {
  const start = options.linesAdded
    ? Math.max(0, options.lineStart - options.startPadSeconds)
    : options.selectionStart;
  const end = options.linesAdded
    ? Math.min(options.mediaEnd, options.lineEnd + options.endPadSeconds)
    : options.selectionEnd;
  const timelineStart =
    start < options.timelineStart
      ? Math.max(0, start - LINE_REVEAL_MARGIN_SECONDS)
      : options.timelineStart;
  const timelineEnd =
    end > options.timelineEnd
      ? Math.min(options.mediaEnd, end + LINE_REVEAL_MARGIN_SECONDS)
      : options.timelineEnd;
  const clip = constrainMediaTimingSelection({
    nextStart: start,
    nextEnd: end,
    currentStart: start,
    timelineStart,
    timelineEnd,
    mediaEnd: options.mediaEnd,
    maxMediaDuration: options.maxMediaDuration,
  });
  return { ...clip, timelineStart, timelineEnd };
}

/**
 * Widens the visible timeline so an edge moved to `target` stays in view, with the same
 * margin added lines get. The view never shrinks here.
 */
export function revealMediaTimingEdge(options: {
  target: number;
  timelineStart: number;
  timelineEnd: number;
  mediaEnd: number;
}): { timelineStart: number; timelineEnd: number } {
  return {
    timelineStart:
      options.target < options.timelineStart
        ? Math.max(0, options.target - LINE_REVEAL_MARGIN_SECONDS)
        : options.timelineStart,
    timelineEnd:
      options.target > options.timelineEnd
        ? Math.min(options.mediaEnd, options.target + LINE_REVEAL_MARGIN_SECONDS)
        : options.timelineEnd,
  };
}

/** Maps a pointer position over the timeline track back onto a media timestamp. */
export function mediaTimingTimeFromPointer(options: {
  clientX: number;
  trackLeft: number;
  trackWidth: number;
  timelineStart: number;
  timelineEnd: number;
}): number {
  if (options.trackWidth <= 0) return options.timelineStart;
  const ratio = clamp((options.clientX - options.trackLeft) / options.trackWidth, 0, 1);
  return options.timelineStart + ratio * (options.timelineEnd - options.timelineStart);
}

/** Slides the selection without resizing it, keeping the whole clip inside the visible timeline. */
export function slideMediaTimingSelection(options: {
  nextStart: number;
  span: number;
  timelineStart: number;
  timelineEnd: number;
  mediaEnd: number;
}): { start: number; end: number } {
  const latestEnd = Math.min(options.timelineEnd, options.mediaEnd);
  const maxStart = Math.max(options.timelineStart, latestEnd - options.span);
  const start = clamp(options.nextStart, options.timelineStart, maxStart);
  return { start, end: start + options.span };
}

export function createMediaTimingReviewModal(
  ctx: RendererContext,
  options: {
    modalStateReader: Pick<ModalStateReader, 'isAnyModalOpen'>;
    syncSettingsModalSubtitleSuppression: () => void;
  },
) {
  let payload: MediaTimingReviewOpenPayload | null = null;
  let selectionStart = 0;
  let selectionEnd = 0;
  let timelineStart = 0;
  let timelineEnd = 0;
  let previousCount = 0;
  let nextCount = 0;
  let startPadSeconds = 0;
  let endPadSeconds = 0;
  /** True until the user moves the clip; the first waveform then trims trailing silence. */
  let trailingTrimPending = false;
  /** Once the user types in the translation it no longer follows added or removed lines. */
  let translationEdited = false;
  let translationEditing = false;
  /**
   * Once the user edits the card sentence it shows as typed in its own field (without the
   * readings over the lines), and added or removed lines go in or out at its ends.
   */
  let sentenceEdited = false;
  let sentenceEditing = false;
  let resolveInFlight = false;
  let previewPlaying = false;
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let waveformTimer: ReturnType<typeof setTimeout> | null = null;
  let waveformSequence = 0;
  let edgeHighlightTimer: ReturnType<typeof setTimeout> | null = null;
  let drag: {
    edge: 'start' | 'end' | 'both';
    pointerId: number;
    trackLeft: number;
    trackWidth: number;
    grabOffset: number;
  } | null = null;

  const focus = createModalFocusGuard({
    isOpen: () => ctx.state.mediaTimingReviewModalOpen,
    getModalRoot: () => ctx.dom.mediaTimingReviewModal,
    getPreferredFocusTargets: () => [
      ctx.dom.mediaTimingReviewStartHandle,
      ctx.dom.mediaTimingReviewCancelBack,
    ],
    getFallbackFocusTarget: () => ctx.dom.mediaTimingReviewCancel,
    isModalLayer: ctx.platform.isModalLayer,
  });
  const previewRequest = createMediaTimingPreviewRequestGuard();
  const framePicker = createMediaTimingFramePicker({
    load: (request) => window.electronAPI.getMediaTimingReviewFrame(request),
    onChange: () => renderFramePicker(),
    onStale: () => closeResolvedReview(),
  });

  function renderFramePicker(): void {
    const state = framePicker.getState();
    const dom = ctx.dom;
    dom.mediaTimingReviewFramePicker.classList.toggle('hidden', !state.enabled);
    dom.mediaTimingReviewFramePicker.setAttribute('aria-busy', String(state.loading));
    dom.mediaTimingReviewFrameSlider.min = String(timelineStart);
    dom.mediaTimingReviewFrameSlider.max = String(Math.max(timelineStart, timelineEnd - 0.001));
    const shownTime = state.loading ? state.requestedTime : state.timestamp;
    if (shownTime !== undefined) dom.mediaTimingReviewFrameSlider.value = String(shownTime);
    dom.mediaTimingReviewFrameTime.textContent =
      shownTime === undefined ? '—' : formatMediaTimingTimestamp(shownTime);
    dom.mediaTimingReviewFrameSlider.setAttribute(
      'aria-valuetext',
      dom.mediaTimingReviewFrameTime.textContent,
    );
    dom.mediaTimingReviewFrameStatus.textContent = state.message;
    dom.mediaTimingReviewFrameImage.classList.toggle('hidden', !state.dataUrl);
    if (state.dataUrl) dom.mediaTimingReviewFrameImage.src = state.dataUrl;
    else dom.mediaTimingReviewFrameImage.removeAttribute('src');
    dom.mediaTimingReviewFramePrevious.disabled =
      resolveInFlight ||
      state.loading ||
      state.timestamp === undefined ||
      state.timestamp <= timelineStart;
    dom.mediaTimingReviewFrameNext.disabled =
      resolveInFlight ||
      state.loading ||
      state.timestamp === undefined ||
      state.timestamp >= timelineEnd - 0.001;
    dom.mediaTimingReviewFrameSlider.disabled = resolveInFlight;
    dom.mediaTimingReviewFrameReset.disabled = resolveInFlight || !state.manual;
    dom.mediaTimingReviewConfirm.disabled =
      resolveInFlight || (state.blockConfirm && !dom.mediaTimingReviewWithoutMedia.checked);
    dom.mediaTimingReviewWithoutMedia.disabled = resolveInFlight;
  }

  function setStatus(message: string, isError = false): void {
    ctx.dom.mediaTimingReviewStatus.textContent = message;
    ctx.dom.mediaTimingReviewStatus.classList.toggle('is-error', isError);
  }

  function clearPreviewTimer(): void {
    if (previewTimer !== null) clearTimeout(previewTimer);
    previewTimer = null;
  }

  function armPreviewTimeout(): void {
    clearPreviewTimer();
    previewTimer = setTimeout(() => {
      stopPreview();
      setStatus('Audio preview stopped responding. Try playing the selection again.', true);
    }, PREVIEW_STALL_TIMEOUT_MS);
  }

  /** Playback position comes from mpv, so stalls and output latency cannot outrun the cursor. */
  function setPreviewPlaying(playing: boolean, finished = false): void {
    previewPlaying = playing;
    ctx.dom.mediaTimingReviewPlayLabel.textContent = playing ? 'Stop preview' : 'Play selection';
    ctx.dom.mediaTimingReviewPlay.classList.toggle('is-playing', playing);
    clearPreviewTimer();
    const track = ctx.dom.mediaTimingReviewSelectionTrack;
    track.classList.toggle('is-previewing', playing || finished);
    if (finished) track.style.setProperty('--playhead-position', 'var(--selection-end)');
    if (!playing) return;
    track.style.setProperty('--playhead-position', 'var(--selection-start)');
    armPreviewTimeout();
  }

  function handlePreviewPosition(position: MediaTimingReviewPreviewPosition): void {
    if (
      !payload ||
      payload.reviewId !== position.reviewId ||
      !previewPlaying ||
      !Number.isFinite(position.time)
    )
      return;
    const time = clamp(position.time, selectionStart, selectionEnd);
    const span = Math.max(MINIMUM_CLIP_SECONDS, timelineEnd - timelineStart);
    ctx.dom.mediaTimingReviewSelectionTrack.style.setProperty(
      '--playhead-position',
      `${clamp(((time - timelineStart) / span) * 100, 0, 100)}%`,
    );
    armPreviewTimeout();
  }

  /** The hidden player reached the end of the clip and paused itself. */
  function handlePreviewEnded(reviewId: string): void {
    if (!payload || payload.reviewId !== reviewId || !previewPlaying) return;
    setPreviewPlaying(false, true);
    setStatus('');
  }

  /** Callers that need to report a failure set their own status after stopping the preview. */
  function stopPreview(): void {
    previewRequest.invalidate();
    setPreviewPlaying(false);
    setStatus('');
    if (payload) {
      void window.electronAPI.stopMediaTimingReviewPreview(payload.reviewId).catch(() => {});
    }
  }

  function renderHandle(handle: HTMLDivElement, value: number): void {
    handle.setAttribute('aria-valuemin', timelineStart.toFixed(3));
    handle.setAttribute('aria-valuemax', timelineEnd.toFixed(3));
    handle.setAttribute('aria-valuenow', value.toFixed(3));
    handle.setAttribute('aria-valuetext', formatMediaTimingTimestamp(value));
  }

  function renderSelection(): void {
    framePicker.updateMidpoint(selectionStart + (selectionEnd - selectionStart) / 2);
    renderFramePicker();
    const span = Math.max(MINIMUM_CLIP_SECONDS, timelineEnd - timelineStart);
    const startPercent = ((selectionStart - timelineStart) / span) * 100;
    const endPercent = ((selectionEnd - timelineStart) / span) * 100;
    const lineRange = currentLineSelection();
    const originalStartPercent = payload
      ? ((lineRange.rangeStart - timelineStart) / span) * 100
      : 0;
    const originalEndPercent = payload ? ((lineRange.rangeEnd - timelineStart) / span) * 100 : 0;
    ctx.dom.mediaTimingReviewSelectionTrack.style.setProperty(
      '--selection-start',
      `${clamp(startPercent, 0, 100)}%`,
    );
    ctx.dom.mediaTimingReviewSelectionTrack.style.setProperty(
      '--selection-end',
      `${clamp(endPercent, 0, 100)}%`,
    );
    ctx.dom.mediaTimingReviewSelectionTrack.style.setProperty(
      '--original-start',
      `${clamp(originalStartPercent, 0, 100)}%`,
    );
    ctx.dom.mediaTimingReviewSelectionTrack.style.setProperty(
      '--original-end',
      `${clamp(originalEndPercent, 0, 100)}%`,
    );
    renderHandle(ctx.dom.mediaTimingReviewStartHandle, selectionStart);
    renderHandle(ctx.dom.mediaTimingReviewEndHandle, selectionEnd);
    ctx.dom.mediaTimingReviewStartValue.textContent = formatMediaTimingTimestamp(selectionStart);
    ctx.dom.mediaTimingReviewEndValue.textContent = formatMediaTimingTimestamp(selectionEnd);
    ctx.dom.mediaTimingReviewDuration.textContent = `${(selectionEnd - selectionStart).toFixed(2)}s`;
  }

  /**
   * Lights up an edge's handle and time while it is dragged, and for a moment after a
   * button or arrow key nudges it. This is separate from focus, so the start handle can
   * hold focus on open (which makes the arrow keys work) without looking selected.
   */
  function highlightEdge(edge: 'start' | 'end' | 'both' | null, linger = false): void {
    if (edgeHighlightTimer !== null) {
      clearTimeout(edgeHighlightTimer);
      edgeHighlightTimer = null;
    }
    const modal = ctx.dom.mediaTimingReviewModal;
    if (edge === null) {
      delete modal.dataset.activeEdge;
      return;
    }
    modal.dataset.activeEdge = edge;
    if (linger) {
      edgeHighlightTimer = setTimeout(() => {
        edgeHighlightTimer = null;
        if (drag === null) delete modal.dataset.activeEdge;
      }, EDGE_HIGHLIGHT_MS);
    }
  }

  function setWaveformState(state: 'loading' | 'ready' | 'unavailable'): void {
    ctx.dom.mediaTimingReviewSelectionTrack.classList.toggle('is-loading', state === 'loading');
    ctx.dom.mediaTimingReviewSelectionTrack.classList.toggle(
      'is-waveform-unavailable',
      state === 'unavailable',
    );
    ctx.dom.mediaTimingReviewWaveformLabel.textContent =
      state === 'loading' ? 'Isolating dialogue...' : state === 'ready' ? '' : 'No waveform';
  }

  async function loadWaveform(): Promise<void> {
    if (!payload || !ctx.state.mediaTimingReviewModalOpen) return;
    waveformSequence += 1;
    const sequence = waveformSequence;
    const reviewId = payload.reviewId;
    const startTime = timelineStart;
    const endTime = timelineEnd;
    setWaveformState('loading');
    ctx.dom.mediaTimingReviewWaveformPath.setAttribute('d', '');
    try {
      const result = await window.electronAPI.getMediaTimingReviewWaveform({
        reviewId,
        startTime,
        endTime,
      });
      if (
        sequence !== waveformSequence ||
        payload?.reviewId !== reviewId ||
        timelineStart !== startTime ||
        timelineEnd !== endTime
      ) {
        return;
      }
      if (!result.ok && result.stale) {
        closeResolvedReview();
        return;
      }
      const path = result.ok ? buildMediaTimingWaveformPath(result.peaks ?? []) : '';
      if (!path) {
        setWaveformState('unavailable');
        return;
      }
      ctx.dom.mediaTimingReviewWaveformPath.setAttribute('d', path);
      setWaveformState('ready');
      trimTrailingSilence(result.peaks ?? []);
    } catch {
      if (sequence === waveformSequence && payload?.reviewId === reviewId) {
        setWaveformState('unavailable');
      }
    }
  }

  /**
   * Moves an untouched clip end back to where the line's dialogue ends. The orange
   * end bar keeps marking the subtitle timing, and Reset restores it.
   */
  function trimTrailingSilence(peaks: readonly number[]): void {
    if (!payload || !trailingTrimPending || previewPlaying || previewRequest.isInFlight()) {
      return;
    }
    const lineRange = currentLineSelection();
    const trimmedEnd = trimMediaTimingSelectionEnd({
      peaks,
      timelineStart,
      timelineEnd,
      lineStart: lineRange.rangeStart,
      lineEnd: lineRange.rangeEnd,
      selectionEnd,
      endPadSeconds,
    });
    if (trimmedEnd === null) return;
    updateSelection(selectionStart, trimmedEnd);
    setStatus('Clip end moved to where the dialogue ends. Reset restores the subtitle timing.');
  }

  function queueWaveformLoad(delayMs = 0): void {
    if (waveformTimer !== null) clearTimeout(waveformTimer);
    waveformSequence += 1;
    if (payload && ctx.state.mediaTimingReviewModalOpen) {
      ctx.dom.mediaTimingReviewWaveformPath.setAttribute('d', '');
      setWaveformState('loading');
    }
    waveformTimer = setTimeout(() => {
      waveformTimer = null;
      void loadWaveform();
    }, delayMs);
  }

  function currentLineSelection(): ReturnType<typeof buildMediaTimingLineSelection> {
    return buildMediaTimingLineSelection({
      previousLines: payload?.previousLines ?? [],
      nextLines: payload?.nextLines ?? [],
      text: payload?.text ?? '',
      originalStartTime: payload?.originalStartTime ?? 0,
      originalEndTime: payload?.originalEndTime ?? 0,
      previousCount,
      nextCount,
    });
  }

  function renderSentence(): void {
    if (!payload) return;
    const selection = currentLineSelection();
    ctx.dom.mediaTimingReviewText.replaceChildren(
      ...selection.lineTexts.map((text, index) => {
        const line = document.createElement('span');
        line.className =
          index === selection.currentLineIndex
            ? 'media-timing-review-line is-current'
            : 'media-timing-review-line';
        line.textContent = text;
        return line;
      }),
    );
    const total = selection.lineTexts.length;
    ctx.dom.mediaTimingReviewLineCount.textContent = total === 1 ? '1 line' : `${total} lines`;
    const hasContext = payload.previousLines.length > 0 || payload.nextLines.length > 0;
    ctx.dom.mediaTimingReviewLineControls.classList.toggle('hidden', !hasContext);
    ctx.dom.mediaTimingReviewPrevAdd.disabled = previousCount >= payload.previousLines.length;
    ctx.dom.mediaTimingReviewPrevRemove.disabled = previousCount <= 0;
    ctx.dom.mediaTimingReviewNextAdd.disabled = nextCount >= payload.nextLines.length;
    ctx.dom.mediaTimingReviewNextRemove.disabled = nextCount <= 0;
    renderSentenceEdit();
  }

  /** Shows the typed sentence in place of the subtitle lines once it was edited. */
  function renderSentenceEdit(): void {
    const dom = ctx.dom;
    const showInput = sentenceEdited || sentenceEditing;
    dom.mediaTimingReviewText.classList.toggle('hidden', showInput);
    dom.mediaTimingReviewSentence.classList.toggle('hidden', !showInput);
    dom.mediaTimingReviewSentence.readOnly = !sentenceEditing;
    const total = currentLineSelection().lineTexts.length;
    const lines = total === 1 ? '1 line' : `${total} lines`;
    dom.mediaTimingReviewLineCount.textContent =
      editedSentence() !== null ? `${lines}, edited` : lines;
  }

  /**
   * The sentence only takes typing while it is being edited: a click on it, or Enter while
   * it is focused, starts that, and Escape or leaving the field ends it, like the
   * translation. Edits start from the sentence the lines on the card make.
   */
  function startSentenceEditing(caret?: number): void {
    if (!payload || resolveInFlight) return;
    const input = ctx.dom.mediaTimingReviewSentence;
    if (!sentenceEdited) input.value = currentLineSelection().sentence;
    sentenceEditing = true;
    renderSentenceEdit();
    input.focus();
    const position = caret === undefined ? input.value.length : clamp(caret, 0, input.value.length);
    input.setSelectionRange(position, position);
  }

  /**
   * Ends typing in the sentence. A sentence typed back to what the lines make, or cleared,
   * is not an edit: the lines (and their readings) show again.
   */
  function stopSentenceEditing(options: { keepFocus: boolean }): void {
    if (!sentenceEditing) return;
    sentenceEditing = false;
    const input = ctx.dom.mediaTimingReviewSentence;
    const value = input.value.trim();
    sentenceEdited = value.length > 0 && !sameSentence(value, currentLineSelection().sentence);
    renderSentenceEdit();
    if (!options.keepFocus) return;
    // Focus stays on the sentence, with the ring that says it is selected, not edited.
    ctx.dom.mediaTimingReviewModal.dataset.keyboardNav = 'true';
    (sentenceEdited ? input : ctx.dom.mediaTimingReviewText).focus();
  }

  /** The sentence the user typed, or null when the card takes the lines' own sentence. */
  function editedSentence(): string | null {
    if (!sentenceEdited && !sentenceEditing) return null;
    const value = ctx.dom.mediaTimingReviewSentence.value.trim();
    return value && !sameSentence(value, currentLineSelection().sentence) ? value : null;
  }

  function clearSentenceEdit(): void {
    sentenceEdited = false;
    sentenceEditing = false;
    ctx.dom.mediaTimingReviewSentence.value = '';
    renderSentenceEdit();
  }

  /**
   * Where a click on the subtitle lines landed in the sentence they make, so editing starts
   * with the caret there. Undefined (the end) when the click selected nothing in them.
   */
  function sentenceCaretFromSelection(): number | undefined {
    const selection = window.getSelection();
    const container = ctx.dom.mediaTimingReviewText;
    if (!selection || !selection.isCollapsed || !selection.anchorNode) return undefined;
    if (!container.contains(selection.anchorNode)) return undefined;
    const lineSelection = currentLineSelection();
    if (lineSelection.sentence !== lineSelection.lineTexts.join(' ')) return undefined;
    const lines = Array.from(container.children);
    const lineIndex = lines.findIndex((line) => line.contains(selection.anchorNode));
    if (lineIndex === -1) return undefined;
    const line = lines[lineIndex]!;
    // Count the text before the caret, leaving out readings drawn over the line.
    let offset = 0;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('rt')) continue;
      if (node === selection.anchorNode) {
        offset += selection.anchorOffset;
        break;
      }
      offset += node.textContent?.length ?? 0;
    }
    const before = lineSelection.lineTexts.slice(0, lineIndex);
    return before.reduce((total, text) => total + text.length + 1, 0) + offset;
  }

  function renderCard(): void {
    const card = payload?.card;
    const dom = ctx.dom;
    const word = card?.word?.trim() ?? '';
    const meaning = card?.meaning?.trim() ?? '';
    dom.mediaTimingReviewWord.textContent = word;
    dom.mediaTimingReviewMeaning.textContent = meaning;
    dom.mediaTimingReviewWordRow.classList.toggle('hidden', !word);
    dom.mediaTimingReviewMeaningRow.classList.toggle('hidden', !meaning);
    dom.mediaTimingReviewCard.classList.toggle('hidden', !word && !meaning);
    dom.mediaTimingReviewTranslationRow.classList.toggle('hidden', !card?.translation);
    dom.mediaTimingReviewTitle.textContent = card ? 'Review card' : 'Review media timing';
  }

  function renderTranslationState(): void {
    ctx.dom.mediaTimingReviewTranslationState.textContent = translationEdited ? 'edited' : 'auto';
  }

  /**
   * The translation only takes typing while it is being edited: a click, or Enter while
   * it is focused, starts that, and Escape or leaving the field ends it. Until
   * then it is a stop for Tab and the arrow keys like any button, so Space, P and N keep
   * their review meaning there.
   */
  function setTranslationEditing(editing: boolean): void {
    translationEditing = editing;
    ctx.dom.mediaTimingReviewTranslation.readOnly = !editing;
  }

  function startTranslationEditing(): void {
    const input = ctx.dom.mediaTimingReviewTranslation;
    setTranslationEditing(true);
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function stopTranslationEditing(): void {
    setTranslationEditing(false);
    // The field stays focused, so show the ring that says it is selected, not edited.
    ctx.dom.mediaTimingReviewModal.dataset.keyboardNav = 'true';
  }

  function setTranslation(text: string, edited: boolean): void {
    ctx.dom.mediaTimingReviewTranslation.value = text;
    translationEdited = edited;
    renderTranslationState();
  }

  /** Keeps an untouched translation in step with the lines on the card. */
  function followTranslation(): void {
    const translation = payload?.card?.translation;
    if (!payload || !translation || translationEdited) return;
    const next = buildMediaTimingReviewTranslation({
      previousLines: payload.previousLines,
      nextLines: payload.nextLines,
      text: payload.text,
      originalStartTime: payload.originalStartTime,
      originalEndTime: payload.originalEndTime,
      previousCount,
      nextCount,
      initialTranslation: translation.text,
      initialTranslationLines: translation.currentLines,
      translationLines: translation.lines,
      lineTranslations: translation.lineTranslations,
      format: translation.format,
    });
    if (next !== null) setTranslation(next, false);
  }

  /**
   * The reviewed translation, sent only when it differs from what main would write on its
   * own: typed by the user, or following added lines.
   */
  function reviewedTranslation(): { translation?: string } {
    const initial = payload?.card?.translation;
    if (!initial) return {};
    const value = ctx.dom.mediaTimingReviewTranslation.value.replace(/\s+/g, ' ').trim();
    // The preview can span lines (a kept multi-sense field); compare it the same way.
    const initialValue = initial.text.replace(/\s+/g, ' ').trim();
    // With lines added, main would resolve the translation anew (and lose one taken from
    // the screen), so the displayed one goes along unless it is the field's own content.
    const linesAdded = previousCount > 0 || nextCount > 0;
    // Main also matches the translation against the card sentence, which a typed sentence
    // need not spell out, so the one the review shows goes along. An empty one stays
    // home: main then still tries its own translation of the typed sentence.
    const typedSentence = editedSentence() !== null && value !== '';
    const followedChange =
      value !== initialValue || ((linesAdded || typedSentence) && !initial.fromField);
    return translationEdited || followedChange ? { translation: value } : {};
  }

  /**
   * Adds or removes an adjacent subtitle line from the card sentence, then follows the
   * affected clip edge to the new outermost line while keeping the user's other edge.
   */
  function adjustLines(direction: 'previous' | 'next', delta: number): void {
    if (!payload || resolveInFlight) return;
    const available =
      direction === 'previous' ? payload.previousLines.length : payload.nextLines.length;
    const current = direction === 'previous' ? previousCount : nextCount;
    const updated = clamp(current + delta, 0, available);
    if (updated === current) return;
    const before = currentLineSelection();
    if (direction === 'previous') previousCount = updated;
    else nextCount = updated;

    const selection = currentLineSelection();
    if (sentenceEdited || sentenceEditing) {
      // The outermost line on that side is the one that came or went.
      const added = updated > current;
      const lines = direction === 'previous' ? (added ? selection : before).previous : null;
      const nextLines = direction === 'next' ? (added ? selection : before).next : null;
      const line = lines ? lines[0] : nextLines![nextLines!.length - 1];
      const input = ctx.dom.mediaTimingReviewSentence;
      input.value = applySentenceLineChange({
        text: input.value,
        line: line?.text ?? '',
        side: direction,
        added,
      });
    }
    const mediaEnd = payload.mediaDuration ?? Number.POSITIVE_INFINITY;
    let timelineChanged = false;
    let capped = false;
    if (direction === 'previous') {
      const target = Math.max(0, selection.rangeStart - startPadSeconds);
      if (target < timelineStart) {
        timelineStart = Math.max(0, target - LINE_REVEAL_MARGIN_SECONDS);
        timelineChanged = true;
      }
      updateSelection(target, selectionEnd);
      capped = selectionStart > target + 0.001;
    } else {
      const target = Math.min(mediaEnd, selection.rangeEnd + endPadSeconds);
      if (target > timelineEnd) {
        timelineEnd = Math.min(mediaEnd, target + LINE_REVEAL_MARGIN_SECONDS);
        timelineChanged = true;
      }
      updateSelection(selectionStart, target);
      capped = selectionEnd < target - 0.001;
    }
    renderSentence();
    followTranslation();
    if (capped && payload.maxMediaDuration > 0) {
      setStatus(
        `Clip length is capped at ${payload.maxMediaDuration}s, so the audio cannot cover every added line.`,
      );
    }
    if (timelineChanged) queueWaveformLoad(120);
  }

  /**
   * Restores the mined clip and timeline view for the lines now on the card. Added lines,
   * the translation and the screenshot stay as they are.
   */
  function resetTiming(): void {
    if (!payload || resolveInFlight) return;
    const lines = currentLineSelection();
    const reset = resolveMediaTimingReset({
      linesAdded: previousCount > 0 || nextCount > 0,
      lineStart: lines.rangeStart,
      lineEnd: lines.rangeEnd,
      startPadSeconds,
      endPadSeconds,
      selectionStart: payload.selectionStartTime,
      selectionEnd: payload.selectionEndTime,
      timelineStart: payload.timelineStartTime,
      timelineEnd: payload.timelineEndTime,
      mediaEnd: payload.mediaDuration ?? Number.POSITIVE_INFINITY,
      maxMediaDuration: payload.maxMediaDuration,
    });
    const timelineChanged =
      reset.timelineStart !== timelineStart || reset.timelineEnd !== timelineEnd;
    timelineStart = reset.timelineStart;
    timelineEnd = reset.timelineEnd;
    // Anchor the constraint on the reset start, so earlier edits cannot change the result.
    selectionStart = reset.start;
    updateSelection(reset.start, reset.end);
    if (timelineChanged) queueWaveformLoad(120);
  }

  /** Returns the review to how it opened: lines, translation, timing, screenshot and media. */
  function resetAll(): void {
    if (!payload || resolveInFlight) return;
    previousCount = 0;
    nextCount = 0;
    clearSentenceEdit();
    renderSentence();
    setTranslation(payload.card?.translation?.text ?? '', false);
    resetTiming();
    ctx.dom.mediaTimingReviewWithoutMedia.checked = false;
    framePicker.reset();
    // Export card is only disabled without media while a screenshot blocks it.
    renderFramePicker();
    // Trimming the trailing silence was part of how the review opened.
    trailingTrimPending = true;
    queueWaveformLoad();
  }

  function updateSelection(nextStart: number, nextEnd: number): void {
    if (!payload) return;
    const mediaEnd = payload.mediaDuration ?? Number.POSITIVE_INFINITY;
    const nextSelection = constrainMediaTimingSelection({
      nextStart,
      nextEnd,
      currentStart: selectionStart,
      timelineStart,
      timelineEnd,
      mediaEnd,
      maxMediaDuration: payload.maxMediaDuration,
    });
    selectionStart = nextSelection.start;
    selectionEnd = nextSelection.end;
    trailingTrimPending = false;
    if (previewPlaying || previewRequest.isInFlight()) stopPreview();
    setStatus('');
    renderSelection();
  }

  /** Shifts the whole clip without changing its length. */
  function moveSelection(nextStart: number): void {
    if (!payload) return;
    const slid = slideMediaTimingSelection({
      nextStart,
      span: selectionEnd - selectionStart,
      timelineStart,
      timelineEnd,
      mediaEnd: payload.mediaDuration ?? Number.POSITIVE_INFINITY,
    });
    updateSelection(slid.start, slid.end);
  }

  function setEdge(edge: 'start' | 'end', value: number): void {
    if (edge === 'start') updateSelection(value, selectionEnd);
    else updateSelection(selectionStart, value);
  }

  /**
   * Moves one edge by a button or arrow key. The timeline widens when the edge would
   * leave the view, so the buttons can reach past what is shown.
   */
  function nudgeEdge(edge: 'start' | 'end', delta: number): void {
    if (!payload || resolveInFlight) return;
    const mediaEnd = payload.mediaDuration ?? Number.POSITIVE_INFINITY;
    const current = edge === 'start' ? selectionStart : selectionEnd;
    // Apply the clip rules (minimum length, length cap, media bounds) before widening,
    // so a move that gets clamped does not widen the view for nothing.
    const next = constrainMediaTimingSelection({
      nextStart: edge === 'start' ? current + delta : selectionStart,
      nextEnd: edge === 'end' ? current + delta : selectionEnd,
      currentStart: selectionStart,
      timelineStart: 0,
      timelineEnd: mediaEnd,
      mediaEnd,
      maxMediaDuration: payload.maxMediaDuration,
    });
    const target = edge === 'start' ? next.start : next.end;
    if (Math.abs(target - current) < 0.0005) return;
    const view = revealMediaTimingEdge({ target, timelineStart, timelineEnd, mediaEnd });
    const timelineChanged =
      view.timelineStart !== timelineStart || view.timelineEnd !== timelineEnd;
    timelineStart = view.timelineStart;
    timelineEnd = view.timelineEnd;
    updateSelection(next.start, next.end);
    highlightEdge(edge, true);
    if (timelineChanged) queueWaveformLoad(120);
  }

  function applyDrag(clientX: number): void {
    if (!drag) return;
    const pointerTime = mediaTimingTimeFromPointer({
      clientX,
      trackLeft: drag.trackLeft,
      trackWidth: drag.trackWidth,
      timelineStart,
      timelineEnd,
    });
    const time = pointerTime - drag.grabOffset;
    if (drag.edge === 'both') moveSelection(time);
    else setEdge(drag.edge, time);
  }

  /**
   * Grabbing a handle drags that edge, grabbing the highlighted clip slides the whole selection,
   * and pressing anywhere else snaps the nearest edge to that point and keeps dragging it.
   */
  function beginDrag(event: PointerEvent): void {
    if (!payload || resolveInFlight || drag !== null || event.button !== 0) return;
    const track = ctx.dom.mediaTimingReviewSelectionTrack;
    const rect = track.getBoundingClientRect();
    const pointerTime = mediaTimingTimeFromPointer({
      clientX: event.clientX,
      trackLeft: rect.left,
      trackWidth: rect.width,
      timelineStart,
      timelineEnd,
    });
    const target = event.target;
    let edge: 'start' | 'end' | 'both';
    let grabOffset: number;
    if (target === ctx.dom.mediaTimingReviewStartHandle) {
      edge = 'start';
      grabOffset = pointerTime - selectionStart;
    } else if (target === ctx.dom.mediaTimingReviewEndHandle) {
      edge = 'end';
      grabOffset = pointerTime - selectionEnd;
    } else if (target === ctx.dom.mediaTimingReviewSelectedRange) {
      edge = 'both';
      grabOffset = pointerTime - selectionStart;
    } else {
      edge =
        Math.abs(pointerTime - selectionStart) <= Math.abs(pointerTime - selectionEnd)
          ? 'start'
          : 'end';
      grabOffset = 0;
    }
    event.preventDefault();
    drag = {
      edge,
      pointerId: event.pointerId,
      trackLeft: rect.left,
      trackWidth: rect.width,
      grabOffset,
    };
    track.setPointerCapture(event.pointerId);
    ctx.dom.mediaTimingReviewModal.classList.add(edge === 'both' ? 'is-sliding' : 'is-scrubbing');
    highlightEdge(edge);
    if (edge !== 'both') {
      const handle =
        edge === 'start'
          ? ctx.dom.mediaTimingReviewStartHandle
          : ctx.dom.mediaTimingReviewEndHandle;
      handle.focus();
      if (grabOffset === 0) applyDrag(event.clientX);
    }
  }

  function endDrag(event: PointerEvent): void {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const track = ctx.dom.mediaTimingReviewSelectionTrack;
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    drag = null;
    ctx.dom.mediaTimingReviewModal.classList.remove('is-scrubbing', 'is-sliding');
    highlightEdge(null);
  }

  function cancelDrag(): void {
    drag = null;
    ctx.dom.mediaTimingReviewModal.classList.remove('is-scrubbing', 'is-sliding');
    highlightEdge(null);
  }

  function isKeyboardNavActive(): boolean {
    return ctx.dom.mediaTimingReviewModal.dataset.keyboardNav !== undefined;
  }

  /**
   * Arrow keys nudge an edge handle that was clicked or focused on open. Once Tab or an
   * arrow key started keyboard navigation, they move between controls instead.
   */
  function handleEdgeKeydown(event: KeyboardEvent, edge: 'start' | 'end'): void {
    if (isKeyboardNavActive()) return;
    const step = event.shiftKey ? COARSE_ADJUST_SECONDS : FINE_ADJUST_SECONDS;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nudgeEdge(edge, -step);
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nudgeEdge(edge, step);
    else if (event.key === 'Home' || event.key === 'End') {
      if (!payload || resolveInFlight) return;
      setEdge(edge, event.key === 'Home' ? timelineStart : timelineEnd);
      highlightEdge(edge, true);
    } else return;
    event.preventDefault();
  }

  function showEditor(): void {
    ctx.dom.mediaTimingReviewCancelStep.classList.add('hidden');
    ctx.dom.mediaTimingReviewEditor.classList.remove('hidden');
    ctx.dom.mediaTimingReviewCancel.classList.remove('hidden');
    ctx.dom.mediaTimingReviewResetAll.classList.remove('hidden');
  }

  /** An audio card is made from a note mined earlier, so cancelling leaves that note alone. */
  function discardChoice(review: MediaTimingReviewOpenPayload): { label: string; message: string } {
    if (review.kind === 'audio') {
      return {
        label: 'Leave card unchanged',
        message: 'Keep editing, or leave this card as it was.',
      };
    }
    return review.noteId !== undefined
      ? { label: 'Delete card', message: 'Keep editing, or delete this card.' }
      : { label: "Don't create card", message: 'Keep editing, or do not create this card.' };
  }

  function requestCancel(): void {
    if (!ctx.state.mediaTimingReviewModalOpen || !payload || resolveInFlight) return;
    stopPreview();
    ctx.dom.mediaTimingReviewEditor.classList.add('hidden');
    ctx.dom.mediaTimingReviewCancel.classList.add('hidden');
    ctx.dom.mediaTimingReviewResetAll.classList.add('hidden');
    ctx.dom.mediaTimingReviewCancelStep.classList.remove('hidden');
    const discard = discardChoice(payload);
    ctx.dom.mediaTimingReviewCancelMessage.textContent = discard.message;
    ctx.dom.mediaTimingReviewDiscard.textContent = discard.label;
    ctx.dom.mediaTimingReviewCancelBack.focus();
  }

  function closeResolvedReview(): void {
    if (!ctx.state.mediaTimingReviewModalOpen) return;
    cancelDrag();
    clearPreviewTimer();
    if (waveformTimer !== null) clearTimeout(waveformTimer);
    waveformTimer = null;
    waveformSequence += 1;
    previewPlaying = false;
    ctx.state.mediaTimingReviewModalOpen = false;
    ctx.dom.mediaTimingReviewModal.classList.add('hidden');
    ctx.dom.mediaTimingReviewModal.setAttribute('aria-hidden', 'true');
    focus.detach();
    window.electronAPI.notifyOverlayModalClosed('media-timing-review');
    options.syncSettingsModalSubtitleSuppression();
    payload = null;
    framePicker.close();
    if (!options.modalStateReader.isAnyModalOpen()) {
      ctx.dom.overlay.classList.remove('interactive');
      if (ctx.platform.shouldToggleMouseIgnore) {
        window.electronAPI.setIgnoreMouseEvents(true, { forward: true });
      }
    }
  }

  async function resolveReview(decision: MediaTimingReviewDecision): Promise<void> {
    if (!payload || resolveInFlight) return;
    resolveInFlight = true;
    renderFramePicker();
    stopPreview();
    const controls = ctx.dom.mediaTimingReviewModal.querySelectorAll<HTMLButtonElement>('button');
    controls.forEach((button) => {
      button.disabled = true;
    });
    ctx.dom.mediaTimingReviewTranslation.disabled = true;
    ctx.dom.mediaTimingReviewSentence.disabled = true;
    try {
      const result = await window.electronAPI.resolveMediaTimingReview({
        reviewId: payload.reviewId,
        decision,
      });
      if (!result.ok && !result.stale) {
        setStatus(result.message ?? 'The timing review could not be resolved.', true);
        showEditor();
        return;
      }
      // A stale review was already settled by main; keeping the modal up would leave
      // controls that can never succeed over a live mpv window.
      closeResolvedReview();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
      showEditor();
    } finally {
      resolveInFlight = false;
      controls.forEach((button) => {
        button.disabled = false;
      });
      ctx.dom.mediaTimingReviewTranslation.disabled = false;
      ctx.dom.mediaTimingReviewSentence.disabled = false;
      renderSelection();
      renderSentence();
    }
  }

  function confirmSelection(): void {
    const withoutMedia = ctx.dom.mediaTimingReviewWithoutMedia.checked;
    // A screenshot that failed to load only blocks exports that include media.
    if (!payload || (framePicker.getState().blockConfirm && !withoutMedia)) return;
    const screenshotTime = withoutMedia ? undefined : framePicker.getScreenshotTime();
    const includesAdjacentLines = previousCount > 0 || nextCount > 0;
    const lines = currentLineSelection();
    // A typed sentence replaces the one the lines make; the range still says which
    // subtitle lines the card covers.
    const typedSentence = editedSentence();
    void resolveReview({
      action: 'confirm',
      startTime: selectionStart,
      endTime: selectionEnd,
      ...(screenshotTime !== undefined ? { screenshotTime } : {}),
      ...(typedSentence !== null ? { text: typedSentence } : {}),
      ...(includesAdjacentLines
        ? {
            text: typedSentence ?? lines.sentence,
            sentenceStartTime: lines.rangeStart,
            sentenceEndTime: lines.rangeEnd,
          }
        : {}),
      ...(withoutMedia ? { skipMedia: true } : {}),
      ...reviewedTranslation(),
    });
  }

  async function togglePreview(): Promise<void> {
    if (!payload || resolveInFlight) return;
    if (previewPlaying) {
      stopPreview();
      return;
    }
    const requestId = previewRequest.begin();
    if (requestId === null) return;
    const requestedReviewId = payload.reviewId;
    setStatus('Starting audio preview...');
    try {
      const result = await window.electronAPI.previewMediaTimingReview({
        reviewId: requestedReviewId,
        startTime: selectionStart,
        endTime: selectionEnd,
      });
      if (!previewRequest.isCurrent(requestId) || payload?.reviewId !== requestedReviewId) {
        if (result.ok && !previewRequest.isInFlight() && !previewPlaying) {
          void window.electronAPI.stopMediaTimingReviewPreview(requestedReviewId).catch(() => {});
        }
        return;
      }
      if (!result.ok && result.stale) {
        closeResolvedReview();
        return;
      }
      if (!result.ok) {
        setStatus(result.message ?? 'Audio preview is unavailable.', true);
        setPreviewPlaying(false);
        return;
      }
      setStatus('Previewing in the hidden audio player.');
      setPreviewPlaying(true);
    } catch (error) {
      if (!previewRequest.isCurrent(requestId) || payload?.reviewId !== requestedReviewId) return;
      setStatus(
        `Audio preview unavailable: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
      setPreviewPlaying(false);
    } finally {
      previewRequest.finish(requestId);
    }
  }

  function openMediaTimingReviewModal(nextPayload: MediaTimingReviewOpenPayload): void {
    previewRequest.invalidate();
    cancelDrag();
    payload = {
      ...nextPayload,
      previousLines: nextPayload.previousLines ?? [],
      nextLines: nextPayload.nextLines ?? [],
    };
    selectionStart = nextPayload.selectionStartTime;
    selectionEnd = nextPayload.selectionEndTime;
    timelineStart = nextPayload.timelineStartTime;
    timelineEnd = nextPayload.timelineEndTime;
    previousCount = 0;
    nextCount = 0;
    clearSentenceEdit();
    startPadSeconds = Math.max(0, nextPayload.originalStartTime - nextPayload.selectionStartTime);
    endPadSeconds = Math.max(0, nextPayload.selectionEndTime - nextPayload.originalEndTime);
    trailingTrimPending = true;
    resolveInFlight = false;
    setPreviewPlaying(false);
    ctx.dom.mediaTimingReviewWithoutMedia.checked = false;
    ctx.dom.mediaTimingReviewKind.textContent =
      nextPayload.kind === 'word'
        ? 'Word card'
        : nextPayload.kind === 'audio'
          ? 'Audio card'
          : 'Sentence card';
    ctx.dom.mediaTimingReviewKind.dataset.kind = nextPayload.kind;
    ctx.dom.mediaTimingReviewDiscard.textContent = discardChoice(nextPayload).label;
    renderCard();
    setTranslation(nextPayload.card?.translation?.text ?? '', false);
    setStatus('');
    showEditor();
    framePicker.open(
      nextPayload.reviewId,
      nextPayload.screenshotEnabled === true,
      selectionStart + (selectionEnd - selectionStart) / 2,
    );
    renderSelection();
    renderSentence();
    ctx.state.mediaTimingReviewModalOpen = true;
    options.syncSettingsModalSubtitleSuppression();
    ctx.dom.overlay.classList.add('interactive');
    if (ctx.platform.shouldToggleMouseIgnore) window.electronAPI.setIgnoreMouseEvents(false);
    delete ctx.dom.mediaTimingReviewModal.dataset.keyboardNav;
    setTranslationEditing(false);
    ctx.dom.mediaTimingReviewModal.classList.remove('hidden');
    ctx.dom.mediaTimingReviewModal.setAttribute('aria-hidden', 'false');
    window.electronAPI.notifyOverlayModalOpened('media-timing-review');
    focus.attach();
    focus.requestOverlayFocus();
    window.focus();
    focus.enforceModalFocus();
    queueWaveformLoad();
  }

  /**
   * Tab and Shift+Tab walk every control of the visible step and wrap at the ends, so
   * focus never leaves the dialog. Focus rings on the handles and the translation only
   * show once Tab was used, so the start handle's focus on open stays invisible.
   */
  function handleTabKey(event: KeyboardEvent): void {
    const modal = ctx.dom.mediaTimingReviewModal;
    modal.dataset.keyboardNav = 'true';
    // The hidden step's controls are filtered out, so the whole modal is the scope.
    const targets = listMediaTimingReviewFocusTargets(modal);
    const active = document.activeElement;
    // From a mouse-only control (the start handle focused on open, the slider) the
    // browser's own move already goes to the next control after it.
    if (
      active instanceof HTMLElement &&
      isMediaTimingReviewFocusInside(modal, active) &&
      !targets.includes(active)
    ) {
      return;
    }
    const target = wrapMediaTimingReviewFocus(targets, active, event.shiftKey);
    if (target === null) return;
    event.preventDefault();
    target.focus();
  }

  /** Arrow keys move the keyboard highlight to the control next to it on screen. */
  function moveFocusByArrow(direction: MediaTimingReviewArrowDirection): void {
    const modal = ctx.dom.mediaTimingReviewModal;
    modal.dataset.keyboardNav = 'true';
    const targets = listMediaTimingReviewFocusTargets(modal);
    if (targets.length === 0) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !isMediaTimingReviewFocusInside(modal, active)) {
      targets[0]!.focus();
      return;
    }
    const index = pickMediaTimingReviewArrowTarget(
      active.getBoundingClientRect(),
      targets.map((target) => target.getBoundingClientRect()),
      direction,
      targets.indexOf(active),
    );
    if (index !== -1) targets[index]!.focus();
  }

  /** Enter presses a focused button or checkbox, as Space would elsewhere. */
  function pressFocusedControl(target: EventTarget | null): void {
    if (target instanceof HTMLButtonElement && !target.disabled) target.click();
    else if (target instanceof HTMLInputElement && target.type === 'checkbox' && !target.disabled)
      target.click();
  }

  function handleMediaTimingReviewKeydown(event: KeyboardEvent): boolean {
    if (!ctx.state.mediaTimingReviewModalOpen) return false;
    const translation = ctx.dom.mediaTimingReviewTranslation;
    const sentence = ctx.dom.mediaTimingReviewSentence;
    // Keys that belong to an IME composition in a field (Escape cancels it).
    if ((event.target === translation || event.target === sentence) && event.isComposing) {
      return false;
    }
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      handleTabKey(event);
      return true;
    }
    const onEditor = ctx.dom.mediaTimingReviewCancelStep.classList.contains('hidden');
    const exportShortcut =
      event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
    if (event.target === translation && translationEditing) {
      // Typing goes to the translation, and Enter types a line break. Escape leaves it
      // without cancelling the review, and Ctrl/Cmd+Enter still exports.
      if (exportShortcut) {
        event.preventDefault();
        confirmSelection();
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        stopTranslationEditing();
        return true;
      }
      return false;
    }
    if (event.target === sentence && sentenceEditing) {
      // The sentence takes typing the same way: Enter is a line break, Escape stops editing.
      if (exportShortcut) {
        event.preventDefault();
        confirmSelection();
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        stopSentenceEditing({ keepFocus: true });
        return true;
      }
      return false;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!onEditor) showEditor();
      else requestCancel();
      return true;
    }
    const direction = mediaTimingReviewArrowDirection(event.key);
    if (direction !== null && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // A clicked edge handle already nudged its edge (see handleEdgeKeydown).
      if (event.defaultPrevented) return true;
      // Everything else, the screenshot slider included, moves the highlight.
      event.preventDefault();
      moveFocusByArrow(direction);
      return true;
    }
    if (
      event.target === ctx.dom.mediaTimingReviewFrameSlider &&
      ['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)
    ) {
      // The screenshot moves with the Frame buttons only, never by keys on the slider.
      event.preventDefault();
      return true;
    }
    if (exportShortcut) {
      event.preventDefault();
      if (onEditor) confirmSelection();
      return true;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      if (event.target === translation) startTranslationEditing();
      else if (event.target === sentence || event.target === ctx.dom.mediaTimingReviewText) {
        startSentenceEditing();
      } else pressFocusedControl(event.target);
      return true;
    }
    if (event.code === 'Space') {
      // Space always previews, even on a focused button: Enter presses buttons.
      event.preventDefault();
      if (onEditor) void togglePreview();
      return true;
    }
    if (
      (event.key === 'p' || event.key === 'P' || event.key === 'n' || event.key === 'N') &&
      ctx.dom.mediaTimingReviewCancelStep.classList.contains('hidden') &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      adjustLines(
        event.key === 'p' || event.key === 'P' ? 'previous' : 'next',
        event.shiftKey ? -1 : 1,
      );
      return true;
    }
    return false;
  }

  function getControllerStep(): MediaTimingReviewStep {
    return ctx.dom.mediaTimingReviewCancelStep.classList.contains('hidden') ? 'editor' : 'cancel';
  }

  /** Presses the on-screen button for a controller action, so every guard it has applies. */
  function handleControllerAction(action: MediaTimingReviewControllerAction): boolean {
    if (!ctx.state.mediaTimingReviewModalOpen) return false;
    const button = ctx.dom[MEDIA_TIMING_REVIEW_CONTROLLER_BUTTONS[action]];
    if (!isMediaTimingReviewButtonAvailable(button)) return false;
    button.click();
    return true;
  }

  /**
   * Hints live in a data attribute drawn by CSS, so they survive code that rewrites a
   * button's text (Skip media / Discard labels change with the card). Unbound actions
   * show no tag. Only changed attributes are written, since this runs every frame.
   */
  function setControllerHints(
    hints: Record<MediaTimingReviewControllerAction, string | null>,
  ): void {
    for (const [action, domKey] of Object.entries(MEDIA_TIMING_REVIEW_CONTROLLER_BUTTONS) as Array<
      [MediaTimingReviewControllerAction, ButtonDomKey]
    >) {
      const button = ctx.dom[domKey];
      const hint = hints[action];
      if (hint === null || hint === undefined) {
        if (button.dataset.controllerHint !== undefined) delete button.dataset.controllerHint;
      } else if (button.dataset.controllerHint !== hint) {
        button.dataset.controllerHint = hint;
      }
    }
  }

  function setControllerHintsVisible(visible: boolean): void {
    ctx.dom.mediaTimingReviewModal.classList.toggle('controller-hints-visible', visible);
  }

  function wireDomEvents(): void {
    // A pointer user does not need the keyboard focus rings until Tab is pressed again.
    // Listen for click, not pointerdown: the Yomitan hover shield swallows presses inside
    // the dialog. Clicks made by Enter (detail 0) keep keyboard navigation on.
    ctx.dom.mediaTimingReviewModal.addEventListener('click', (event) => {
      if (event.detail > 0) delete ctx.dom.mediaTimingReviewModal.dataset.keyboardNav;
    });
    ctx.dom.mediaTimingReviewFrameSlider.addEventListener('input', () => {
      if (!resolveInFlight) framePicker.choose(Number(ctx.dom.mediaTimingReviewFrameSlider.value));
    });
    const stepFrame = (direction: -1 | 1) => {
      const state = framePicker.getState();
      if (!resolveInFlight && !state.loading && state.timestamp !== undefined)
        framePicker.choose(state.timestamp, direction);
    };
    ctx.dom.mediaTimingReviewFramePrevious.addEventListener('click', () => stepFrame(-1));
    ctx.dom.mediaTimingReviewFrameNext.addEventListener('click', () => stepFrame(1));
    ctx.dom.mediaTimingReviewFrameReset.addEventListener('click', () => {
      if (!resolveInFlight) framePicker.reset();
    });
    const track = ctx.dom.mediaTimingReviewSelectionTrack;
    track.addEventListener('pointerdown', beginDrag);
    track.addEventListener('pointermove', (event) => {
      if (drag?.pointerId === event.pointerId) applyDrag(event.clientX);
    });
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    ctx.dom.mediaTimingReviewStartHandle.addEventListener('keydown', (event) =>
      handleEdgeKeydown(event, 'start'),
    );
    ctx.dom.mediaTimingReviewEndHandle.addEventListener('keydown', (event) =>
      handleEdgeKeydown(event, 'end'),
    );
    const nudgeButtons: Array<[HTMLButtonElement, 'start' | 'end', number]> = [
      [ctx.dom.mediaTimingReviewStartBackCoarse, 'start', -JUMP_ADJUST_SECONDS],
      [ctx.dom.mediaTimingReviewStartBack, 'start', -FINE_ADJUST_SECONDS],
      [ctx.dom.mediaTimingReviewStartForward, 'start', FINE_ADJUST_SECONDS],
      [ctx.dom.mediaTimingReviewStartForwardCoarse, 'start', JUMP_ADJUST_SECONDS],
      [ctx.dom.mediaTimingReviewEndBackCoarse, 'end', -JUMP_ADJUST_SECONDS],
      [ctx.dom.mediaTimingReviewEndBack, 'end', -FINE_ADJUST_SECONDS],
      [ctx.dom.mediaTimingReviewEndForward, 'end', FINE_ADJUST_SECONDS],
      [ctx.dom.mediaTimingReviewEndForwardCoarse, 'end', JUMP_ADJUST_SECONDS],
    ];
    for (const [button, edge, delta] of nudgeButtons) {
      button.addEventListener('click', () => nudgeEdge(edge, delta));
    }
    ctx.dom.mediaTimingReviewPlay.addEventListener('click', () => void togglePreview());
    ctx.dom.mediaTimingReviewReset.addEventListener('click', () => resetTiming());
    ctx.dom.mediaTimingReviewResetAll.addEventListener('click', () => resetAll());
    // A click into the translation edits it straight away (the caret stays where it landed).
    ctx.dom.mediaTimingReviewTranslation.addEventListener('click', () => {
      if (!ctx.dom.mediaTimingReviewTranslation.disabled) setTranslationEditing(true);
    });
    ctx.dom.mediaTimingReviewTranslation.addEventListener('blur', () => {
      // Focus is still here when only the window lost it (Alt+Tab), so keep editing.
      if (document.activeElement !== ctx.dom.mediaTimingReviewTranslation) {
        setTranslationEditing(false);
      }
    });
    ctx.dom.mediaTimingReviewTranslation.addEventListener('input', () => {
      if (translationEdited) return;
      translationEdited = true;
      renderTranslationState();
    });
    // A click on the subtitle lines edits the sentence, unless it selected text in them.
    ctx.dom.mediaTimingReviewText.addEventListener('click', () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      startSentenceEditing(sentenceCaretFromSelection());
    });
    ctx.dom.mediaTimingReviewSentence.addEventListener('click', () => {
      const input = ctx.dom.mediaTimingReviewSentence;
      if (input.disabled || sentenceEditing) return;
      // The caret stays where the click put it.
      sentenceEditing = true;
      renderSentenceEdit();
    });
    ctx.dom.mediaTimingReviewSentence.addEventListener('input', () => renderSentenceEdit());
    ctx.dom.mediaTimingReviewSentence.addEventListener('blur', () => {
      // Focus is still here when only the window lost it (Alt+Tab), so keep editing.
      if (document.activeElement !== ctx.dom.mediaTimingReviewSentence) {
        stopSentenceEditing({ keepFocus: false });
      }
    });
    ctx.dom.mediaTimingReviewPrevAdd.addEventListener('click', () => adjustLines('previous', 1));
    ctx.dom.mediaTimingReviewPrevRemove.addEventListener('click', () =>
      adjustLines('previous', -1),
    );
    ctx.dom.mediaTimingReviewNextAdd.addEventListener('click', () => adjustLines('next', 1));
    ctx.dom.mediaTimingReviewNextRemove.addEventListener('click', () => adjustLines('next', -1));
    ctx.dom.mediaTimingReviewCancel.addEventListener('click', requestCancel);
    ctx.dom.mediaTimingReviewCancelBack.addEventListener('click', showEditor);
    ctx.dom.mediaTimingReviewWithoutMedia.addEventListener('change', () => renderFramePicker());
    ctx.dom.mediaTimingReviewDiscard.addEventListener(
      'click',
      () => void resolveReview({ action: 'discard' }),
    );
    ctx.dom.mediaTimingReviewConfirm.addEventListener('click', () => confirmSelection());
  }

  return {
    openMediaTimingReviewModal,
    handlePreviewEnded,
    handlePreviewPosition,
    requestCancel,
    handleMediaTimingReviewKeydown,
    wireDomEvents,
    getControllerStep,
    handleControllerAction,
    setControllerHints,
    setControllerHintsVisible,
  };
}
