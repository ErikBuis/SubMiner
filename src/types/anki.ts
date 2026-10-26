import type { AiFeatureConfig } from './integrations';
import type { NotificationType } from './notification';
import type { NPlusOneMatchMode } from './subtitle';

/**
 * Card that a Kiku/Lapis note generates. The note types mark this with mutually
 * exclusive `Is...Card` flag fields, so only one kind may be flagged per note.
 */
export type CardKind = 'sentence' | 'audio' | 'word-and-sentence' | 'click';

/** Card kind SubMiner flags on word cards; 'none' leaves the flag fields untouched. */
export type WordCardKind = CardKind | 'none';

export type MediaTimingReviewKind = 'word' | 'sentence' | 'audio';

export interface MediaTimingReviewRequest {
  kind: MediaTimingReviewKind;
  text: string;
  startTime: number;
  endTime: number;
  noteId?: number;
  audioPadding: number;
  maxMediaDuration: number;
  /** Still screenshots only; animated images continue to follow the audio range. */
  screenshotEnabled?: boolean;
  /** What else the card will get, so the review covers the whole export. */
  card?: MediaTimingReviewCardPreview;
}

/** Card fields shown alongside the media timing. Only the translation is editable. */
export interface MediaTimingReviewCardPreview {
  word?: string;
  /** Plain text; one line per sense. */
  meaning?: string;
  /** Set when the card gets a translation; the review then shows an editable field. */
  translation?: {
    text: string;
    /** Secondary subtitle lines around the clip, used to follow added or removed lines. */
    lines: MediaTimingReviewContextLine[];
    /** The secondary lines behind `text`; empty when it came from the live subtitle. */
    currentLines: MediaTimingReviewContextLine[];
    /** The secondary lines the sentence grouping assigns each primary line near the clip. */
    lineTranslations: MediaTimingReviewLineTranslation[];
    /** Apply the card translation formatting when following added or removed lines. */
    format: boolean;
    /** `text` is what the field already holds and keeps unless the review changes it. */
    fromField?: boolean;
  };
}

export interface MediaTimingReviewLineTranslation {
  /** The primary line's text, which tells apart lines sharing one interval. */
  text?: string;
  startTime: number;
  endTime: number;
  lines: MediaTimingReviewContextLine[];
}

/** A subtitle line adjacent to the mined one that the review can pull onto the card. */
export interface MediaTimingReviewContextLine {
  text: string;
  startTime: number;
  endTime: number;
}

export type MediaTimingReviewDecision =
  /** `text` is set when the review combined adjacent lines into the card sentence. */
  | {
      action: 'confirm';
      startTime: number;
      endTime: number;
      text?: string;
      /** Subtitle range of the lines behind `text`; the clip itself can be padded or trimmed. */
      sentenceStartTime?: number;
      sentenceEndTime?: number;
      screenshotTime?: number;
      /** The reviewed card translation, when the card gets one. */
      translation?: string;
    }
  | { action: 'use-original'; translation?: string }
  | { action: 'skip-media'; translation?: string }
  | { action: 'discard' };

export interface MediaTimingReviewOpenPayload {
  reviewId: string;
  kind: MediaTimingReviewKind;
  text: string;
  /** Lines before/after the mined one, both chronological: nearest previous line is last, nearest next line is first. */
  previousLines: MediaTimingReviewContextLine[];
  nextLines: MediaTimingReviewContextLine[];
  noteId?: number;
  originalStartTime: number;
  originalEndTime: number;
  selectionStartTime: number;
  selectionEndTime: number;
  timelineStartTime: number;
  timelineEndTime: number;
  mediaDuration?: number;
  maxMediaDuration: number;
  screenshotEnabled?: boolean;
  card?: MediaTimingReviewCardPreview;
}

export interface MediaTimingReviewFrameRequest {
  reviewId: string;
  timestamp: number;
  /** Step to the adjacent decoded frame instead of seeking to a time. */
  direction?: -1 | 1;
}

export interface MediaTimingReviewFrameResult extends MediaTimingReviewActionResult {
  dataUrl?: string;
  timestamp?: number;
}

export interface MediaTimingReviewPreviewRequest {
  reviewId: string;
  startTime: number;
  endTime: number;
}

export interface MediaTimingReviewPreviewPosition {
  reviewId: string;
  time: number;
}

export interface MediaTimingReviewWaveformRequest {
  reviewId: string;
  startTime: number;
  endTime: number;
}

export interface MediaTimingReviewWaveformResult extends MediaTimingReviewActionResult {
  peaks?: number[];
}

export interface MediaTimingReviewResolveRequest {
  reviewId: string;
  decision: MediaTimingReviewDecision;
}

export interface MediaTimingReviewActionResult {
  ok: boolean;
  message?: string;
  /** The review this request targeted has already ended; the renderer should close. */
  stale?: boolean;
}

export interface NotificationOptions {
  body?: string;
  icon?: string;
}

export interface KikuDuplicateCardInfo {
  noteId: number;
  expression: string;
  sentencePreview: string;
  hasAudio: boolean;
  hasImage: boolean;
  isOriginal: boolean;
}

export interface KikuFieldGroupingRequestData {
  original: KikuDuplicateCardInfo;
  duplicate: KikuDuplicateCardInfo;
}

export interface KikuFieldGroupingChoice {
  keepNoteId: number;
  deleteNoteId: number;
  deleteDuplicate: boolean;
  cancelled: boolean;
}

export interface KikuMergePreviewRequest {
  keepNoteId: number;
  deleteNoteId: number;
  deleteDuplicate: boolean;
}

export interface KikuMergePreviewResponse {
  ok: boolean;
  compact?: Record<string, unknown>;
  full?: Record<string, unknown>;
  error?: string;
}

export interface AnkiConnectConfig {
  enabled?: boolean;
  url?: string;
  pollingRate?: number;
  proxy?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    upstreamUrl?: string;
  };
  tags?: string[];
  fields?: {
    word?: string;
    audio?: string;
    wordAudio?: string;
    image?: string;
    sentence?: string;
    miscInfo?: string;
    wordCardTranslation?: string;
    definition?: string;
    translation?: string;
  };
  ai?: boolean | AiFeatureConfig;
  media?: {
    generateAudio?: boolean;
    generateImage?: boolean;
    imageType?: 'static' | 'avif';
    imageFormat?: 'jpg' | 'png' | 'webp';
    imageQuality?: number;
    imageMaxWidth?: number;
    imageMaxHeight?: number;
    animatedFps?: number;
    animatedMaxWidth?: number;
    animatedMaxHeight?: number;
    animatedCrf?: number;
    syncAnimatedImageToWordAudio?: boolean;
    normalizeAudio?: boolean;
    mirrorMpvVolume?: boolean;
    reviewTiming?: boolean;
    audioPadding?: number;
    fallbackDuration?: number;
    maxMediaDuration?: number;
  };
  knownWords?: {
    highlightEnabled?: boolean;
    maturityEnabled?: boolean;
    matureThresholdDays?: number;
    refreshMinutes?: number;
    addMinedWordsImmediately?: boolean;
    matchMode?: NPlusOneMatchMode;
    decks?: Record<string, string[]>;
    color?: string;
  };
  nPlusOne?: {
    enabled?: boolean;
    minSentenceWords?: number;
  };
  behavior?: {
    overwriteAudio?: boolean;
    overwriteImage?: boolean;
    widenSentenceToTranslation?: boolean;
    formatTranslation?: boolean;
    mediaInsertMode?: 'append' | 'prepend';
    highlightWord?: boolean;
    notificationType?: NotificationType;
    autoUpdateNewCards?: boolean;
  };
  metadata?: {
    pattern?: string;
  };
  deck?: string;
  isLapis?: {
    enabled?: boolean;
    sentenceCardModel?: string;
  };
  isKiku?: {
    enabled?: boolean;
    fieldGrouping?: 'auto' | 'manual' | 'disabled';
    deleteDuplicateInAuto?: boolean;
  };
  isSenren?: {
    enabled?: boolean;
    fieldGrouping?: 'auto' | 'manual' | 'disabled';
    deleteDuplicateInAuto?: boolean;
  };
  lapisKiku?: {
    wordCardKind?: WordCardKind;
  };
}
