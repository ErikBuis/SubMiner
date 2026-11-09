import { randomUUID } from 'crypto';
import type {
  MediaTimingReviewActionResult,
  MediaTimingReviewContextLine,
  MediaTimingReviewDecision,
  MediaTimingReviewFurigana,
  MediaTimingReviewOpenPayload,
  MediaTimingReviewOutcome,
  MediaTimingReviewPreviewRequest,
  MediaTimingReviewPreviewPosition,
  MediaTimingReviewRequest,
  MediaTimingReviewResolveRequest,
  MediaTimingReviewFrameRequest,
  MediaTimingReviewFrameResult,
  MediaTimingReviewWaveformRequest,
  MediaTimingReviewWaveformResult,
} from '../../types/anki';
import type { SpeechWaveformOptions } from '../../core/services/media-timing-waveform';
import type { MediaTimingPreviewStartOptions } from '../../core/services/media-timing-preview';
import type { MediaTimingFrameOptions } from '../../core/services/media-timing-frame';
import {
  isRemoteMediaWindowSourcePath,
  type RemoteMediaWindow,
  type RemoteMediaWindowRange,
  type RemoteMediaWindowSource,
} from '../../core/services/remote-media-window-cache';
import type { MpvInputLock } from '../../core/services/mpv-input-lock';
import type { MediaInput, MediaInputOptions } from '../../media-input';
import {
  REVIEW_CONTEXT_EPSILON_SECONDS as CONTEXT_LINE_EPSILON_SECONDS,
  REVIEW_CONTEXT_LINE_LIMIT as CONTEXT_LINE_LIMIT,
} from '../../shared/sentence-translation-alignment';
import { protectEscapedBrackets } from '../../shared/furigana-markup';
import { removeSpeakerLabels } from '../../shared/subtitle-speaker-labels';

const INITIAL_TIMELINE_MARGIN_SECONDS = 2;

interface ReviewMpvClient {
  connected: boolean;
  currentVideoPath: string;
  currentAudioStreamIndex?: number | null;
  requestProperty?: (name: string) => Promise<unknown>;
  send: (payload: { command: Array<string | number> }) => void;
}

interface PreviewSession {
  start(options: MediaTimingPreviewStartOptions): Promise<void>;
  play(startTime: number, endTime: number): Promise<void>;
  stop(): Promise<void>;
  /** Fires when the player reaches the end of the clip started by play(). */
  onPlaybackEnded(listener: () => void): void;
  dispose(): void;
}

interface ReviewMediaSource {
  path: string;
  inputOptions?: MediaInputOptions;
  singleResolvedStream?: boolean;
}

interface ActiveReview {
  payload: MediaTimingReviewOpenPayload;
  /** What the hidden mpv preview plays when no cached window is available. */
  mediaPath: string;
  /** What the waveform reads when no cached window is available. */
  waveformMedia: MediaInput;
  videoSource: ReviewMediaSource | null;
  frameInFlight: boolean;
  audioStreamIndex?: number;
  /** Remote source to download windows of; null for local media or without a cache. */
  windowSource: RemoteMediaWindowSource | null;
  /** Latest window returned for this review; reused while it still covers the request. */
  window: RemoteMediaWindow | null;
  windowRequest: (RemoteMediaWindowRange & { promise: Promise<RemoteMediaWindow | null> }) | null;
  windowFailed: boolean;
  previewOptions: { executablePath?: string; audioTrackId?: number; volume?: number };
  preview: { path: string; session: Promise<PreviewSession> } | null;
  mpvClient: ReviewMpvClient;
  restorePlayback: boolean;
  resolve: (decision: MediaTimingReviewDecision) => void;
}

interface ReviewRequestLifecycle {
  /** What mpv played when the request started; the card's media must come from it. */
  mediaPath: string;
  /** mpv closed or switched files during the request. */
  mediaClosed: boolean;
  signal: AbortSignal;
  cancelled: Promise<void>;
  settled: Promise<void>;
  isCancelled(): boolean;
  cancel(): void;
  markSettled(): void;
}

export interface MediaTimingReviewRuntimeDeps {
  getMpvClient: () => ReviewMpvClient | null;
  getCurrentMediaPath: () => string | null;
  getMpvExecutablePath: () => string;
  createPreviewSession: () => PreviewSession;
  generateWaveform: (options: SpeechWaveformOptions) => Promise<number[]>;
  /** Resolves the FFmpeg-readable stream URL and headers behind the current media path. */
  resolveMediaSource?: () => Promise<ReviewMediaSource | null>;
  resolveVideoSource?: () => Promise<ReviewMediaSource | null>;
  generateFrame?: (
    options: MediaTimingFrameOptions,
  ) => Promise<{ dataUrl: string; timestamp: number }>;
  clearFrameCache?: () => void;
  /** Downloads (or reuses) a local window of a remote source covering the range. */
  acquireMediaWindow?: (
    source: RemoteMediaWindowSource,
    range: RemoteMediaWindowRange,
  ) => Promise<RemoteMediaWindow>;
  getSubtitleContextLines?: (range: { startTime: number; endTime: number }) => {
    previous: MediaTimingReviewContextLine[];
    next: MediaTimingReviewContextLine[];
  };
  openModal: (payload: MediaTimingReviewOpenPayload, signal: AbortSignal) => Promise<boolean>;
  /** Blocks mpv's own key and mouse bindings while the modal is open. */
  inputLock?: Pick<MpvInputLock, 'lock' | 'unlock'>;
  /** Tells the modal that main ended the review on its own, so it should close. */
  onReviewEnded?: (reviewId: string) => void;
  /** Tells the modal that the hidden player finished the previewed clip. */
  onPreviewEnded?: (reviewId: string) => void;
  onPreviewPosition?: (position: MediaTimingReviewPreviewPosition) => void;
  /** Readings for one line of Japanese as plain bracket furigana; null when unavailable. */
  generateFurigana?: (text: string) => Promise<string | null>;
  /** Sends readings for the review's lines to the open modal. */
  onFurigana?: (furigana: MediaTimingReviewFurigana) => void;
  showStatus: (message: string) => void;
}

const KANJI_PATTERN = /[\p{Script=Han}\u3005]/u;

/**
 * The texts the review can show that need readings: the card's own text first, then the
 * nearby lines the user can add, nearest first. Lines without kanji need none.
 */
export function reviewFuriganaTexts(
  payload: Pick<MediaTimingReviewOpenPayload, 'text' | 'previousLines' | 'nextLines'>,
): string[] {
  const previous = [...payload.previousLines].reverse();
  const nearby: string[] = [];
  for (let index = 0; index < Math.max(previous.length, payload.nextLines.length); index++) {
    const before = previous[index];
    const after = payload.nextLines[index];
    if (before) nearby.push(before.text);
    if (after) nearby.push(after.text);
  }
  return [...new Set([payload.text, ...nearby])].filter((text) => KANJI_PATTERN.test(text));
}

/** A line without readings, with its literal brackets kept apart from reading delimiters. */
function plainFuriganaLine(line: string): string {
  return protectEscapedBrackets(line.replace(/\[/g, '&#91;').replace(/\]/g, '&#93;'));
}

/**
 * Readings for a text, generated line by line so its line breaks stay where they are.
 * Null when no line got a reading.
 */
export async function generateReviewTextFurigana(
  text: string,
  generate: (line: string) => Promise<string | null>,
): Promise<string | null> {
  let annotated = false;
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let furigana: string | null = null;
    if (KANJI_PATTERN.test(line)) {
      try {
        furigana = await generate(line.trim());
      } catch {
        furigana = null;
      }
    }
    if (furigana && furigana.includes('[')) annotated = true;
    lines.push(furigana || plainFuriganaLine(line));
  }
  return annotated ? lines.join('\n') : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanProperty(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'yes' || value === 1) return true;
  if (value === 'no' || value === 0) return false;
  return null;
}

function createReviewRequestLifecycle(mediaPath: string): ReviewRequestLifecycle {
  const controller = new AbortController();
  let resolveCancellation: (() => void) | null = null;
  let resolveSettled: (() => void) | null = null;
  const cancellation = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  return {
    mediaPath,
    mediaClosed: false,
    signal: controller.signal,
    cancelled: cancellation,
    settled,
    isCancelled: () => controller.signal.aborted,
    cancel: () => {
      if (controller.signal.aborted) return;
      controller.abort();
      resolveCancellation?.();
    },
    markSettled: () => {
      resolveSettled?.();
      resolveSettled = null;
    },
  };
}

/**
 * Picks the subtitle lines adjacent to the mined range that the review modal can pull
 * onto the card. Parsed cues cover both directions; when none are loaded (e.g. the
 * active track was never parsed) the timing tracker's history still provides the
 * lines that already played, so only "next" is unavailable.
 */
export function collectMediaTimingContextLines(options: {
  cues: readonly { text: string; startTime: number; endTime: number }[];
  fallbackPrevious?: readonly { displayText: string; startTime: number; endTime: number }[];
  startTime: number;
  endTime: number;
}): { previous: MediaTimingReviewContextLine[]; next: MediaTimingReviewContextLine[] } {
  const usable = options.cues
    .filter(
      (cue) =>
        cue.text.trim().length > 0 &&
        Number.isFinite(cue.startTime) &&
        Number.isFinite(cue.endTime) &&
        cue.endTime > cue.startTime,
    )
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);

  let previous = usable
    .filter((cue) => cue.endTime <= options.startTime + CONTEXT_LINE_EPSILON_SECONDS)
    .slice(-CONTEXT_LINE_LIMIT)
    .map(({ text, startTime, endTime }) => ({ text: text.trim(), startTime, endTime }));
  const next = usable
    .filter((cue) => cue.startTime >= options.endTime - CONTEXT_LINE_EPSILON_SECONDS)
    .slice(0, CONTEXT_LINE_LIMIT)
    .map(({ text, startTime, endTime }) => ({ text: text.trim(), startTime, endTime }));

  if (previous.length === 0 && options.fallbackPrevious) {
    previous = options.fallbackPrevious
      .filter(
        (entry) =>
          entry.displayText.trim().length > 0 &&
          Number.isFinite(entry.startTime) &&
          Number.isFinite(entry.endTime) &&
          entry.endTime > entry.startTime &&
          entry.endTime <= options.startTime + CONTEXT_LINE_EPSILON_SECONDS,
      )
      .slice(-CONTEXT_LINE_LIMIT)
      .map((entry) => ({
        text: entry.displayText.trim(),
        startTime: entry.startTime,
        endTime: entry.endTime,
      }));
  }
  return { previous, next };
}

/**
 * Result for requests that name a review main has already resolved or disposed (overlay
 * teardown, a crashed modal renderer, duplicate modal). The renderer closes on it instead
 * of leaving the user with controls that can never succeed.
 */
function staleReviewResult(): MediaTimingReviewActionResult {
  return { ok: false, stale: true, message: 'This timing review is no longer active.' };
}

function isValidMediaTimingRange(
  payload: MediaTimingReviewOpenPayload,
  startTime: number,
  endTime: number,
): boolean {
  return (
    Number.isFinite(startTime) &&
    Number.isFinite(endTime) &&
    startTime >= 0 &&
    endTime > startTime &&
    (payload.maxMediaDuration <= 0 || endTime - startTime <= payload.maxMediaDuration + 0.001) &&
    (payload.mediaDuration === undefined || endTime <= payload.mediaDuration + 0.001)
  );
}

function cleanContextLines(
  lines: MediaTimingReviewContextLine[] | undefined,
  strip: boolean | undefined,
): MediaTimingReviewContextLine[] {
  if (!lines) return [];
  if (!strip) return lines;
  // A cue holding only a label has nothing to add to the sentence, and composing it
  // after dialogue would leave the label mid-line where the card cleanup cannot see it.
  return lines
    .map((line) => ({ ...line, text: removeSpeakerLabels(line.text) }))
    .filter((line) => line.text.length > 0);
}

export function buildMediaTimingReviewPayload(
  request: MediaTimingReviewRequest,
  options: {
    reviewId: string;
    mediaDuration?: number;
    contextLines?: {
      previous: MediaTimingReviewContextLine[];
      next: MediaTimingReviewContextLine[];
    };
  },
): MediaTimingReviewOpenPayload {
  const duration = finiteNumber(options.mediaDuration);
  const maxTime = duration !== null && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const paddedStart = Math.max(0, request.startTime - request.audioPadding);
  let paddedEnd = Math.min(maxTime, request.endTime + request.audioPadding);
  const maxMediaDuration = Math.max(0, request.maxMediaDuration);
  if (maxMediaDuration > 0 && paddedEnd - paddedStart > maxMediaDuration) {
    paddedEnd = paddedStart + maxMediaDuration;
  }
  if (paddedEnd <= paddedStart) {
    paddedEnd = Math.min(maxTime, paddedStart + 0.1);
  }

  const timelineStartTime = Math.max(0, paddedStart - INITIAL_TIMELINE_MARGIN_SECONDS);
  const timelineEndTime = Math.max(
    paddedEnd,
    Math.min(maxTime, paddedEnd + INITIAL_TIMELINE_MARGIN_SECONDS),
  );

  return {
    reviewId: options.reviewId,
    kind: request.kind,
    text: request.text,
    previousLines: cleanContextLines(options.contextLines?.previous, request.stripSpeakerLabels),
    nextLines: cleanContextLines(options.contextLines?.next, request.stripSpeakerLabels),
    ...(request.stripSpeakerLabels ? { stripSpeakerLabels: true } : {}),
    ...(request.noteId !== undefined ? { noteId: request.noteId } : {}),
    originalStartTime: request.startTime,
    originalEndTime: request.endTime,
    selectionStartTime: paddedStart,
    selectionEndTime: paddedEnd,
    timelineStartTime,
    timelineEndTime,
    ...(duration !== null && duration > 0 ? { mediaDuration: duration } : {}),
    maxMediaDuration,
    ...(request.screenshotEnabled !== undefined
      ? { screenshotEnabled: request.screenshotEnabled }
      : {}),
    ...(request.card ? { card: request.card } : {}),
  };
}

export function createMediaTimingReviewRuntime(deps: MediaTimingReviewRuntimeDeps) {
  let active: ActiveReview | null = null;
  let currentRequest: ReviewRequestLifecycle | null = null;
  let pendingPauseRestore: ReviewMpvClient | null = null;
  let resumeDeferred = false;
  /** Set when the overlay pauses during the current request, even before its setup reads the pause state. */
  let restoreCancelled = false;

  function currentMediaPath(): string {
    return (
      deps.getCurrentMediaPath()?.trim() || deps.getMpvClient()?.currentVideoPath?.trim() || ''
    );
  }

  /** Whether mpv no longer plays the media the request started on. */
  function hasMediaClosed(lifecycle: ReviewRequestLifecycle): boolean {
    if (lifecycle.mediaClosed) return true;
    // Without media at the start the review never opens, and there is nothing to protect.
    if (!lifecycle.mediaPath) return false;
    return deps.getMpvClient()?.connected !== true || currentMediaPath() !== lifecycle.mediaPath;
  }

  function restorePendingPlayback(): void {
    const mpvClient = pendingPauseRestore;
    pendingPauseRestore = null;
    if (mpvClient?.connected) {
      mpvClient.send({ command: ['set_property', 'pause', 'no'] });
    }
  }

  function resumeDeferredPlayback(): void {
    if (!resumeDeferred) return;
    resumeDeferred = false;
    const mpvClient = deps.getMpvClient();
    if (mpvClient?.connected) {
      mpvClient.send({ command: ['set_property', 'pause', 'no'] });
    }
  }

  /**
   * Holds an overlay request to resume playback (e.g. an auto-pause released because the
   * dictionary popup closed) until the pending review ends, then applies it. Returns false
   * when no review holds playback, so the caller should resume right away.
   */
  function deferPlaybackResume(): boolean {
    if (!active && !currentRequest) return false;
    resumeDeferred = true;
    return true;
  }

  /**
   * The overlay asked to pause while a review holds playback, so closing the review must
   * not resume it: drops both a held overlay resume and the review's own restore.
   */
  function cancelPlaybackResume(): void {
    if (!currentRequest) return;
    resumeDeferred = false;
    restoreCancelled = true;
    if (active) active.restorePlayback = false;
  }

  function ensureWindow(
    review: ActiveReview,
    range: RemoteMediaWindowRange,
  ): Promise<RemoteMediaWindow | null> {
    const { windowSource } = review;
    if (!windowSource || review.windowFailed || !deps.acquireMediaWindow) {
      return Promise.resolve(null);
    }
    const coversRange = (candidate: RemoteMediaWindowRange): boolean =>
      candidate.startTime <= range.startTime && candidate.endTime >= range.endTime;
    if (review.window && coversRange(review.window)) return Promise.resolve(review.window);
    const inFlight = review.windowRequest;
    if (inFlight && coversRange(inFlight)) return inFlight.promise;

    const request = {
      startTime: range.startTime,
      endTime: range.endTime,
      promise: Promise.resolve<RemoteMediaWindow | null>(null),
    };
    request.promise = deps
      .acquireMediaWindow(windowSource, { startTime: range.startTime, endTime: range.endTime })
      .then((window) => {
        review.window = window;
        return window;
      })
      .catch(() => {
        // Fall back to the remote source for the rest of this review instead of retrying.
        review.windowFailed = true;
        return null;
      })
      .finally(() => {
        if (review.windowRequest === request) review.windowRequest = null;
      });
    review.windowRequest = request;
    return request.promise;
  }

  /**
   * Returns the preview player for the range, restarting it when the range needs a
   * different file (the first cached window, or a wider one after the timeline grew).
   */
  async function previewFor(
    review: ActiveReview,
    range: RemoteMediaWindowRange,
  ): Promise<PreviewSession> {
    const window = await ensureWindow(review, range);
    if (active !== review) {
      // The review ended during the download; do not start a player nobody will dispose.
      throw new Error('This timing review is no longer active.');
    }
    const mediaPath = window?.path ?? review.mediaPath;
    if (review.preview?.path === mediaPath) return review.preview.session;

    const previous = review.preview;
    const session = deps.createPreviewSession();
    const { audioTrackId, ...previewOptions } = review.previewOptions;
    const startSession = async (): Promise<PreviewSession> => {
      if (active !== review) {
        throw new Error('This timing review is no longer active.');
      }
      await session.start({
        mediaPath,
        onPlaybackPosition: (time) => {
          if (active === review && review.preview?.session === started) {
            deps.onPreviewPosition?.({ reviewId: review.payload.reviewId, time });
          }
        },
        ...previewOptions,
        // A cached window keeps one audio stream, so mpv's track id from the source no longer applies.
        ...(window
          ? { absoluteTimestamps: true }
          : audioTrackId !== undefined
            ? { audioTrackId }
            : {}),
      });
      return session;
    };
    const started = Promise.resolve()
      .then(startSession)
      .catch((error: unknown) => {
        session.dispose();
        throw error;
      });
    review.preview = { path: mediaPath, session: started };
    session.onPlaybackEnded(() => {
      if (active === review && review.preview?.session === started) {
        deps.onPreviewEnded?.(review.payload.reviewId);
      }
    });
    void started.catch(() => {});
    if (previous) void previous.session.then((old) => old.dispose()).catch(() => {});
    return started;
  }

  /**
   * Generates readings for the lines the review can show and sends them once the modal is
   * open, so opening never waits on them. The card's own text goes out first; the nearby
   * lines follow together.
   */
  async function sendReviewFurigana(review: ActiveReview, opened: Promise<boolean>): Promise<void> {
    const { generateFurigana, onFurigana } = deps;
    if (!generateFurigana || !onFurigana) return;
    const texts = reviewFuriganaTexts(review.payload);
    const lines: MediaTimingReviewFurigana['lines'] = [];
    let sent = 0;
    for (const [index, text] of texts.entries()) {
      if (active !== review) return;
      const furigana = await generateReviewTextFurigana(text, generateFurigana);
      if (furigana) lines.push({ text, furigana });
      if (index !== 0 && index !== texts.length - 1) continue;
      if (!(await opened) || active !== review) return;
      if (lines.length > sent) {
        sent = lines.length;
        onFurigana({ reviewId: review.payload.reviewId, lines: [...lines] });
      }
    }
  }

  async function runReview(
    request: MediaTimingReviewRequest,
    lifecycle: ReviewRequestLifecycle,
  ): Promise<MediaTimingReviewDecision> {
    const mpvClient = deps.getMpvClient();
    const mediaPath =
      deps.getCurrentMediaPath()?.trim() || mpvClient?.currentVideoPath?.trim() || '';
    if (!mpvClient?.connected || !mediaPath) {
      deps.showStatus('Timing review unavailable. Using the original subtitle timing.');
      return { action: 'use-original' };
    }

    const setupPromise = Promise.all([
      mpvClient.requestProperty?.('pause').catch(() => null) ?? null,
      mpvClient.requestProperty?.('duration').catch(() => null) ?? null,
      mpvClient.requestProperty?.('aid').catch(() => null) ?? null,
      mpvClient.requestProperty?.('volume').catch(() => null) ?? null,
      deps.resolveMediaSource?.().catch(() => null) ?? null,
      request.screenshotEnabled ? (deps.resolveVideoSource?.().catch(() => null) ?? null) : null,
    ]);
    const setup = await Promise.race([
      setupPromise.then((values) => ({ kind: 'ready' as const, values })),
      lifecycle.cancelled.then(() => ({ kind: 'cancelled' as const })),
    ]);
    if (setup.kind === 'cancelled' || lifecycle.isCancelled()) {
      return { action: 'use-original' };
    }
    const [pauseRaw, durationRaw, audioTrackRaw, volumeRaw, resolvedSource, videoSource] =
      setup.values;
    const pauseState = booleanProperty(pauseRaw);
    // The pause read can predate an overlay pause that arrived during setup.
    pendingPauseRestore = pauseState === false && !restoreCancelled ? mpvClient : null;
    mpvClient.send({ command: ['set_property', 'pause', 'yes'] });
    if (lifecycle.isCancelled()) {
      restorePendingPlayback();
      return { action: 'use-original' };
    }

    let contextLines: ReturnType<NonNullable<typeof deps.getSubtitleContextLines>> | undefined;
    try {
      contextLines = deps.getSubtitleContextLines?.({
        startTime: request.startTime,
        endTime: request.endTime,
      });
    } catch {
      contextLines = undefined;
    }
    const payload = buildMediaTimingReviewPayload(request, {
      reviewId: randomUUID(),
      mediaDuration: finiteNumber(durationRaw) ?? undefined,
      ...(contextLines ? { contextLines } : {}),
    });
    const sourcePath = resolvedSource?.path.trim() || mediaPath;
    const inputOptions = resolvedSource?.inputOptions;
    const audioStreamIndex =
      resolvedSource?.singleResolvedStream || mpvClient.currentAudioStreamIndex == null
        ? undefined
        : mpvClient.currentAudioStreamIndex;
    const windowSource: RemoteMediaWindowSource | null =
      deps.acquireMediaWindow && isRemoteMediaWindowSourcePath(sourcePath)
        ? {
            path: sourcePath,
            ...(inputOptions ? { inputOptions } : {}),
            audioStreamIndex: audioStreamIndex ?? null,
          }
        : null;

    let resolveDecision!: (decision: MediaTimingReviewDecision) => void;
    const decisionPromise = new Promise<MediaTimingReviewDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const review: ActiveReview = {
      payload,
      mediaPath,
      waveformMedia: inputOptions ? { path: sourcePath, inputOptions } : sourcePath,
      videoSource,
      frameInFlight: false,
      ...(audioStreamIndex !== undefined ? { audioStreamIndex } : {}),
      windowSource,
      window: null,
      windowRequest: null,
      windowFailed: false,
      previewOptions: {
        executablePath: deps.getMpvExecutablePath(),
        audioTrackId: finiteNumber(audioTrackRaw) ?? undefined,
        volume: finiteNumber(volumeRaw) ?? undefined,
      },
      preview: null,
      mpvClient,
      restorePlayback: pendingPauseRestore === mpvClient,
      resolve: resolveDecision,
    };
    active = review;
    pendingPauseRestore = null;
    // From here until cleanup, keys that reach the mpv window behind the dialog (after alt+tab,
    // or a click on the video) must not change playback or settings.
    deps.inputLock?.lock();
    // Download the visible timeline once now; the waveform and preview both wait on it.
    void previewFor(review, {
      startTime: payload.timelineStartTime,
      endTime: payload.timelineEndTime,
    }).catch(() => {});

    if (lifecycle.isCancelled() || active !== review) {
      await cleanupActiveReview(review);
      return { action: 'use-original' };
    }
    const openModal = deps.openModal(payload, lifecycle.signal).catch(() => false);
    void sendReviewFurigana(review, openModal);
    const openResult = await Promise.race([
      openModal.then((opened) => ({ kind: 'opened' as const, opened })),
      lifecycle.cancelled.then(() => ({ kind: 'cancelled' as const })),
    ]);
    if (openResult.kind === 'cancelled' || lifecycle.isCancelled() || active !== review) {
      await cleanupActiveReview(review);
      return { action: 'use-original' };
    }
    const { opened } = openResult;
    if (!opened) {
      await cleanupActiveReview(review);
      deps.showStatus('Timing review could not open. Using the original subtitle timing.');
      return { action: 'use-original' };
    }

    // No time limit: the user may leave the dialog open for as long as they like. The review
    // ends on a decision, when mpv closes, or when the dialog's window closes or its renderer dies.
    let decision: MediaTimingReviewDecision = { action: 'use-original' };
    const decisionResult = await Promise.race([
      decisionPromise.then((value) => ({ kind: 'decided' as const, value })),
      lifecycle.cancelled.then(() => ({ kind: 'cancelled' as const })),
    ]);
    if (decisionResult.kind === 'decided') {
      decision = decisionResult.value;
    }
    await cleanupActiveReview(review);
    return decision;
  }

  async function requestReview(
    request: MediaTimingReviewRequest,
  ): Promise<MediaTimingReviewOutcome> {
    if (active || currentRequest) {
      deps.showStatus('Finish the current timing review before mining another card.');
      return { action: 'use-original' };
    }
    const lifecycle = createReviewRequestLifecycle(
      deps.getMpvClient()?.connected === true ? currentMediaPath() : '',
    );
    currentRequest = lifecycle;
    restoreCancelled = false;
    try {
      const decision = await runReview(request, lifecycle);
      // Whatever ended the review (a decision, mpv closing, the overlay closing as the
      // app quits), the card would now get media and source info from the wrong player state.
      return hasMediaClosed(lifecycle) ? { action: 'media-closed' } : decision;
    } catch {
      await cleanupActiveReview();
      restorePendingPlayback();
      if (hasMediaClosed(lifecycle)) return { action: 'media-closed' };
      deps.showStatus('Timing review failed. Using the original subtitle timing.');
      return { action: 'use-original' };
    } finally {
      if (currentRequest === lifecycle) {
        currentRequest = null;
        resumeDeferredPlayback();
      }
      lifecycle.markSettled();
    }
  }

  async function previewRange(
    request: MediaTimingReviewPreviewRequest,
  ): Promise<MediaTimingReviewActionResult> {
    const current = active;
    if (!current || request.reviewId !== current.payload.reviewId) {
      return staleReviewResult();
    }
    if (!isValidMediaTimingRange(current.payload, request.startTime, request.endTime)) {
      return { ok: false, message: 'The selected preview range is invalid.' };
    }
    try {
      const previewSession = await previewFor(current, request);
      if (active !== current) {
        return staleReviewResult();
      }
      await previewSession.play(request.startTime, request.endTime);
      // Playback spans the whole clip, so the review can end (overlay teardown) while
      // it runs; reporting success would leave the modal open on a dead review.
      if (active !== current) {
        return staleReviewResult();
      }
      return { ok: true };
    } catch (error) {
      if (active !== current) {
        return staleReviewResult();
      }
      return {
        ok: false,
        message: `Audio preview unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async function getWaveform(
    request: MediaTimingReviewWaveformRequest,
  ): Promise<MediaTimingReviewWaveformResult> {
    const current = active;
    if (!current || request.reviewId !== current.payload.reviewId) {
      return staleReviewResult();
    }
    if (
      !Number.isFinite(request.startTime) ||
      !Number.isFinite(request.endTime) ||
      request.startTime < 0 ||
      request.endTime <= request.startTime ||
      (current.payload.mediaDuration !== undefined &&
        request.endTime > current.payload.mediaDuration + 0.001)
    ) {
      return { ok: false, message: 'The waveform range is invalid.' };
    }

    try {
      const window = await ensureWindow(current, request);
      if (active !== current) {
        return staleReviewResult();
      }
      const peaks = await deps.generateWaveform({
        mediaPath: window?.media ?? current.waveformMedia,
        startTime: request.startTime,
        endTime: request.endTime,
        ...(!window && current.audioStreamIndex !== undefined
          ? { audioStreamIndex: current.audioStreamIndex }
          : {}),
      });
      // ffmpeg decoding runs long enough for the review to end underneath it.
      if (active !== current) {
        return staleReviewResult();
      }
      if (peaks.length < 2 || peaks.some((peak) => !Number.isFinite(peak))) {
        return { ok: false, message: 'Timing waveform is unavailable.' };
      }
      return { ok: true, peaks };
    } catch {
      if (active !== current) {
        return staleReviewResult();
      }
      return { ok: false, message: 'Timing waveform is unavailable.' };
    }
  }

  async function getFrame(
    request: MediaTimingReviewFrameRequest,
  ): Promise<MediaTimingReviewFrameResult> {
    const current = active;
    if (!current || request.reviewId !== current.payload.reviewId) return staleReviewResult();
    if (!current.payload.screenshotEnabled || !deps.generateFrame || !current.videoSource) {
      return { ok: false, message: 'Screenshot preview is unavailable for this media.' };
    }
    if (
      !Number.isFinite(request.timestamp) ||
      request.timestamp < 0 ||
      (current.payload.mediaDuration !== undefined &&
        request.timestamp >= current.payload.mediaDuration) ||
      (request.direction !== undefined && request.direction !== -1 && request.direction !== 1)
    ) {
      return { ok: false, message: 'The screenshot time is invalid.' };
    }
    if (current.frameInFlight)
      return { ok: false, message: 'A screenshot preview is already loading.' };
    current.frameInFlight = true;
    try {
      // Reuse the audio window only when it contains this same video source (not split streams).
      const range = {
        startTime: Math.max(0, Math.min(current.payload.timelineStartTime, request.timestamp - 2)),
        endTime: Math.min(
          current.payload.mediaDuration ?? Infinity,
          Math.max(current.payload.timelineEndTime, request.timestamp + 2),
        ),
      };
      const window =
        current.windowSource?.path === current.videoSource.path
          ? await ensureWindow(current, range)
          : null;
      if (active !== current) return staleReviewResult();
      const frame = await deps.generateFrame({
        media: window?.media ?? current.videoSource,
        timestamp: request.timestamp,
        ...(request.direction !== undefined ? { direction: request.direction } : {}),
      });
      if (active !== current) return staleReviewResult();
      return { ok: true, ...frame };
    } catch {
      if (active !== current) return staleReviewResult();
      return {
        ok: false,
        message: 'Screenshot preview unavailable. Try another time or reset to the midpoint.',
      };
    } finally {
      current.frameInFlight = false;
    }
  }

  async function stopPreview(reviewId: string): Promise<MediaTimingReviewActionResult> {
    const current = active;
    if (!current || reviewId !== current.payload.reviewId) {
      return staleReviewResult();
    }
    try {
      const previewSession = current.preview ? await current.preview.session : null;
      if (active !== current) {
        return staleReviewResult();
      }
      await previewSession?.stop();
      if (active !== current) {
        return staleReviewResult();
      }
      return { ok: true };
    } catch (error) {
      if (active !== current) {
        return staleReviewResult();
      }
      return {
        ok: false,
        message: `Could not stop preview: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  function resolveReview(request: MediaTimingReviewResolveRequest): MediaTimingReviewActionResult {
    const current = active;
    if (!current || request.reviewId !== current.payload.reviewId) {
      return staleReviewResult();
    }
    if (request.decision.action === 'confirm') {
      const { startTime, endTime, text, screenshotTime } = request.decision;
      if (!isValidMediaTimingRange(current.payload, startTime, endTime)) {
        return { ok: false, message: 'The selected timing range is invalid.' };
      }
      if (text !== undefined && (typeof text !== 'string' || text.trim().length === 0)) {
        return { ok: false, message: 'The combined sentence text is invalid.' };
      }
      if (
        screenshotTime !== undefined &&
        (!current.payload.screenshotEnabled ||
          !Number.isFinite(screenshotTime) ||
          screenshotTime < 0 ||
          (current.payload.mediaDuration !== undefined &&
            screenshotTime >= current.payload.mediaDuration))
      ) {
        return { ok: false, message: 'The screenshot time is invalid.' };
      }
    }
    current.resolve(request.decision);
    return { ok: true };
  }

  async function cleanupActiveReview(expected?: ActiveReview): Promise<void> {
    const current = active;
    if (expected && current !== expected) return;
    active = null;
    if (!current) return;
    deps.inputLock?.unlock();
    deps.clearFrameCache?.();
    void current.preview?.session.then((session) => session.dispose()).catch(() => {});
    if ((current.restorePlayback || resumeDeferred) && current.mpvClient.connected) {
      resumeDeferred = false;
      current.mpvClient.send({ command: ['set_property', 'pause', 'no'] });
    }
  }

  /**
   * mpv disconnected or loaded other media. Ends a pending review right away, so its
   * dialog closes and the card is left as it was.
   */
  function handleMediaClosed(): void {
    const request = currentRequest;
    if (!request || request.mediaClosed || !hasMediaClosed(request)) return;
    request.mediaClosed = true;
    const reviewId = active?.payload.reviewId;
    request.cancel();
    if (reviewId) deps.onReviewEnded?.(reviewId);
  }

  async function dispose(): Promise<void> {
    const request = currentRequest;
    request?.cancel();
    active?.resolve({ action: 'use-original' });
    await cleanupActiveReview();
    restorePendingPlayback();
    await request?.settled;
  }

  return {
    requestReview,
    previewRange,
    getWaveform,
    getFrame,
    stopPreview,
    resolveReview,
    deferPlaybackResume,
    cancelPlaybackResume,
    handleMediaClosed,
    dispose,
  };
}
