import { DEFAULT_ANKI_CONNECT_CONFIG } from '../config';
import { getPreferredWordValueFromExtractedFields } from '../anki-field-config';
import type { SubtitleMiningContext } from '../types/subtitle';
import type {
  CardKind,
  MediaTimingReviewCardPreview,
  MediaTimingReviewDecision,
  MediaTimingReviewRequest,
  WordCardKind,
} from '../types/anki';
import { resolveWordCardKind } from './note-field-utils';
import { STATS_MINING_TAG } from '../shared/anki-source';
import {
  ankiFieldHtmlToPlainText,
  plainTextToAnkiFieldHtml,
  buildReviewTranslationContext,
  resolveTimedSentenceTranslation,
  toReviewLine,
  widenSentenceToTranslation,
  type SubtitleTracksForTranslation,
} from './sentence-translation';
import { formatCardTranslation } from '../shared/sentence-translation-alignment';

export interface NoteUpdateWorkflowNoteInfo {
  noteId: number;
  tags?: string[];
  fields: Record<string, { value: string }>;
}

export interface NoteUpdateWorkflowDeps {
  client: {
    notesInfo(noteIds: number[]): Promise<unknown>;
    updateNoteFields(noteId: number, fields: Record<string, string>): Promise<void>;
    storeMediaFile(filename: string, data: Buffer): Promise<void>;
    deleteNotes(noteIds: number[]): Promise<void>;
  };
  getConfig: () => {
    fields?: {
      word?: string;
      sentence?: string;
      audio?: string;
      image?: string;
      miscInfo?: string;
      wordCardTranslation?: string;
      definition?: string;
    };
    media?: {
      generateAudio?: boolean;
      generateImage?: boolean;
      imageType?: 'static' | 'avif';
      syncAnimatedImageToWordAudio?: boolean;
      maxMediaDuration?: number;
    };
    behavior?: {
      overwriteAudio?: boolean;
      overwriteImage?: boolean;
      widenSentenceToTranslation?: boolean;
      formatTranslation?: boolean;
    };
  };
  getCurrentSubtitleText: () => string | undefined;
  getCurrentSubtitleStart: () => number | undefined;
  /** Parsed subtitle tracks for picking the translation by timing; null when not parsed. */
  getSubtitleTracksForTranslation?: () =>
    | Promise<SubtitleTracksForTranslation | null>
    | SubtitleTracksForTranslation
    | null;
  /** Live secondary subtitle, only when the on-screen primary line matches `primaryText`. */
  getLiveSecondarySubtitleFor?: (primaryText: string) => string | undefined;
  getEffectiveSentenceCardConfig: () => {
    sentenceField: string;
    lapisEnabled: boolean;
    kikuEnabled: boolean;
    fieldGroupingMode: 'auto' | 'manual' | 'disabled';
    wordCardKind?: WordCardKind;
  };
  appendKnownWordsFromNoteInfo: (noteInfo: NoteUpdateWorkflowNoteInfo) => void;
  removeKnownWordNote: (noteId: number) => void;
  extractFields: (fields: Record<string, { value: string }>) => Record<string, string>;
  findDuplicateNote: (
    expression: string,
    excludeNoteId: number,
    noteInfo: NoteUpdateWorkflowNoteInfo,
  ) => Promise<number | null>;
  handleFieldGroupingAuto: (
    originalNoteId: number,
    newNoteId: number,
    newNoteInfo: NoteUpdateWorkflowNoteInfo,
    expression: string,
  ) => Promise<void>;
  handleFieldGroupingManual: (
    originalNoteId: number,
    newNoteId: number,
    newNoteInfo: NoteUpdateWorkflowNoteInfo,
    expression: string,
  ) => Promise<boolean>;
  processSentence: (mpvSentence: string, noteFields: Record<string, string>) => string;
  processSentenceFurigana?: (
    sentenceFurigana: string,
    noteFields: Record<string, string>,
  ) => string;
  generateSentenceFurigana?: (
    text: string,
    noteFields: Record<string, string>,
  ) => Promise<string | null>;
  setCardTypeFields: (
    updatedFields: Record<string, string>,
    availableFieldNames: string[],
    cardKind: CardKind,
  ) => void;
  resolveConfiguredFieldName: (
    noteInfo: NoteUpdateWorkflowNoteInfo,
    ...preferredNames: (string | undefined)[]
  ) => string | null;
  getAnimatedImageLeadInSeconds: (noteInfo: NoteUpdateWorkflowNoteInfo) => Promise<number>;
  mergeFieldValue: (existing: string, newValue: string, overwrite: boolean) => string;
  generateAudioFilename: () => string;
  generateAudio: (context?: SubtitleMiningContext) => Promise<Buffer | null>;
  generateImageFilename: () => string;
  generateImage: (
    animatedLeadInSeconds?: number,
    context?: SubtitleMiningContext,
  ) => Promise<Buffer | null>;
  formatMiscInfoPattern: (fallbackFilename: string, startTimeSeconds?: number) => string;
  consumeSubtitleMiningContext?: () => SubtitleMiningContext | null;
  captureSubtitleMediaContext?: () => SubtitleMiningContext | null;
  queuePendingYoutubeMediaUpdate?: (job: {
    noteId: number;
    noteInfo: NoteUpdateWorkflowNoteInfo;
    context?: SubtitleMiningContext;
    label: string | number;
  }) => Promise<boolean>;
  addConfiguredTagsToNote: (noteId: number) => Promise<void>;
  showNotification: (noteId: number, label: string | number) => Promise<void>;
  showOsdNotification: (message: string) => void;
  beginUpdateProgress: (initialMessage: string) => void;
  endUpdateProgress: () => void;
  logWarn: (message: string, ...args: unknown[]) => void;
  logInfo: (message: string, ...args: unknown[]) => void;
  logError: (message: string, ...args: unknown[]) => void;
  reviewMediaTiming?: (
    request: Omit<MediaTimingReviewRequest, 'audioPadding' | 'maxMediaDuration'>,
  ) => Promise<MediaTimingReviewDecision>;
  /** Whether `reviewMediaTiming` opens a review; false skips preparing its preview. */
  isMediaTimingReviewEnabled?: () => boolean;
}

function normalizeSubtitleContextText(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasUsableSubtitleContextTiming(context: SubtitleMiningContext): boolean {
  return (
    Number.isFinite(context.startTime) &&
    Number.isFinite(context.endTime) &&
    context.endTime > context.startTime
  );
}

function subtitleContextMatchesSentence(contextText: string, noteSentence: string): boolean {
  const normalizedContext = normalizeSubtitleContextText(contextText);
  const normalizedSentence = normalizeSubtitleContextText(noteSentence);
  if (!normalizedContext || !normalizedSentence) {
    return false;
  }
  return (
    normalizedContext === normalizedSentence ||
    normalizedContext.includes(normalizedSentence) ||
    normalizedSentence.includes(normalizedContext)
  );
}

export class NoteUpdateWorkflow {
  constructor(private readonly deps: NoteUpdateWorkflowDeps) {}

  /** The definition field as plain text, so the review shows what the card explains. */
  private getReviewMeaning(
    noteInfo: NoteUpdateWorkflowNoteInfo,
    definitionField: string | undefined,
  ): { meaning?: string } {
    const fieldName = definitionField
      ? this.deps.resolveConfiguredFieldName(noteInfo, definitionField)
      : null;
    const meaning = fieldName
      ? ankiFieldHtmlToPlainText(noteInfo.fields[fieldName]?.value ?? '')
      : '';
    return meaning ? { meaning } : {};
  }

  /** The translation the card would get, so the review can show, follow and edit it. */
  private buildReviewTranslation(
    context: { text: string; startTime: number; endTime: number },
    options: {
      tracks: SubtitleTracksForTranslation | null;
      format: boolean;
      /** The field's current value, which the card keeps when nothing replaces it. */
      existing: string;
      /** The secondary line on screen for a primary line. */
      liveTranslation: (primaryText: string) => string | undefined;
    },
  ): Pick<MediaTimingReviewCardPreview, 'translation'> {
    const timedTranslation = resolveTimedSentenceTranslation({
      ...context,
      tracks: options.tracks,
    });
    // The line on screen only stands in when there is no parsed secondary track.
    const cue =
      timedTranslation?.translation ??
      (options.tracks && options.tracks.secondary.length > 0
        ? ''
        : (options.liveTranslation(context.text) ?? ''));
    // Formatted as the card saves it, then decoded: the review edits plain text.
    const text = cue
      ? ankiFieldHtmlToPlainText(options.format ? formatCardTranslation(cue) : cue)
      : '';
    const reviewContext = buildReviewTranslationContext({ ...context, tracks: options.tracks });
    return {
      translation: {
        text: text || ankiFieldHtmlToPlainText(options.existing),
        lines: reviewContext.lines,
        currentLines: (timedTranslation?.translationLines ?? []).map(toReviewLine),
        lineTranslations: reviewContext.lineTranslations,
        format: options.format,
        ...(text ? {} : { fromField: true }),
      },
    };
  }

  private consumeMatchingSubtitleMiningContext(
    fields: Record<string, string>,
    sentenceField: string,
    configuredSentenceField?: string,
  ): SubtitleMiningContext | null {
    const context = this.deps.consumeSubtitleMiningContext?.() ?? null;
    if (!context || !hasUsableSubtitleContextTiming(context)) {
      return null;
    }

    const candidateFields = [
      sentenceField,
      configuredSentenceField,
      DEFAULT_ANKI_CONNECT_CONFIG.fields.sentence,
    ];
    const noteSentence = candidateFields
      .map((fieldName) => (fieldName ? fields[fieldName.toLowerCase()] : undefined))
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0);

    if (!noteSentence || subtitleContextMatchesSentence(context.text, noteSentence)) {
      return context;
    }
    return null;
  }

  async execute(noteId: number, options?: { skipFieldGrouping?: boolean }): Promise<void> {
    this.deps.beginUpdateProgress('Updating card');
    try {
      const notesInfoResult = await this.deps.client.notesInfo([noteId]);
      const notesInfo = notesInfoResult as NoteUpdateWorkflowNoteInfo[];
      if (!notesInfo || notesInfo.length === 0) {
        this.deps.logWarn('Card not found:', noteId);
        return;
      }

      const noteInfo = notesInfo[0]!;
      if (noteInfo.tags?.includes(STATS_MINING_TAG)) {
        this.deps.appendKnownWordsFromNoteInfo(noteInfo);
        return;
      }
      const fields = this.deps.extractFields(noteInfo.fields);
      const config = this.deps.getConfig();

      const expressionText = getPreferredWordValueFromExtractedFields(fields, config).trim();
      const hasExpressionText = expressionText.length > 0;
      if (!hasExpressionText) {
        // Some note types omit Expression/Word; still run enrichment updates and skip duplicate checks.
        this.deps.logWarn(
          'No expression/word field found in card; skipping duplicate checks but continuing update:',
          noteId,
        );
      }

      const sentenceCardConfig = this.deps.getEffectiveSentenceCardConfig();
      const shouldRunFieldGrouping =
        !options?.skipFieldGrouping && sentenceCardConfig.fieldGroupingMode !== 'disabled';
      let duplicateNoteId: number | null = null;
      if (shouldRunFieldGrouping && hasExpressionText) {
        duplicateNoteId = await this.deps.findDuplicateNote(expressionText, noteId, noteInfo);
      }

      const updatedFields: Record<string, string> = {};
      let updatePerformed = false;
      let miscInfoFilename: string | null = null;
      const configuredSentenceField =
        config.fields?.sentence ?? DEFAULT_ANKI_CONNECT_CONFIG.fields.sentence;
      const sentenceField = this.deps.resolveConfiguredFieldName(noteInfo, configuredSentenceField);
      const subtitleMiningContext = this.consumeMatchingSubtitleMiningContext(
        fields,
        sentenceField ?? configuredSentenceField,
        configuredSentenceField,
      );
      // Audio and image generation run sequentially and audio extraction can take tens of
      // seconds, so resolve the clip range exactly once up front; reading live mpv sub
      // timings per generator clips whichever line is on screen when each one starts.
      let mediaTimingContext =
        subtitleMiningContext ?? this.deps.captureSubtitleMediaContext?.() ?? null;
      let skipMedia = false;
      let reviewedSentenceText: string | undefined;
      const noteLabel = hasExpressionText ? expressionText : noteId;
      let tracks: Promise<SubtitleTracksForTranslation | null> | undefined;
      const getTracks = () =>
        (tracks ??= Promise.resolve(this.deps.getSubtitleTracksForTranslation?.() ?? null));
      // Read once: playback moves on while the review is open, and the card must get the
      // translation the review showed.
      const liveTranslations = new Map<string, string | undefined>();
      const getLiveTranslation = (primaryText: string) => {
        if (!liveTranslations.has(primaryText)) {
          liveTranslations.set(primaryText, this.deps.getLiveSecondarySubtitleFor?.(primaryText));
        }
        return liveTranslations.get(primaryText);
      };

      let widenedSentenceText: string | undefined;
      if (mediaTimingContext && config.behavior?.widenSentenceToTranslation) {
        const widened = widenSentenceToTranslation({
          text: mediaTimingContext.text,
          startTime: mediaTimingContext.startTime,
          endTime: mediaTimingContext.endTime,
          tracks: await getTracks(),
          maxSentenceSeconds: config.media?.maxMediaDuration ?? 0,
        });
        if (widened) {
          widenedSentenceText = widened.text;
          mediaTimingContext = { ...mediaTimingContext, ...widened };
        }
      }

      // The subtitle lines behind the sentence. The reviewed clip is padded or trimmed
      // audio, so only lines the review adds widen this.
      let sentenceRange = mediaTimingContext
        ? { startTime: mediaTimingContext.startTime, endTime: mediaTimingContext.endTime }
        : null;
      const translationFieldName = config.fields?.wordCardTranslation
        ? this.deps.resolveConfiguredFieldName(noteInfo, config.fields.wordCardTranslation)
        : null;
      const formatTranslation = config.behavior?.formatTranslation === true;
      let reviewedTranslation: string | undefined;
      let keepTranslationField = false;

      if (mediaTimingContext) {
        const reviewMediaTiming =
          this.deps.isMediaTimingReviewEnabled?.() === false
            ? undefined
            : this.deps.reviewMediaTiming;
        const reviewTranslation =
          reviewMediaTiming && translationFieldName
            ? this.buildReviewTranslation(mediaTimingContext, {
                tracks: await getTracks(),
                format: formatTranslation,
                existing: noteInfo.fields[translationFieldName]?.value ?? '',
                liveTranslation: getLiveTranslation,
              })
            : {};
        const timingDecision = reviewMediaTiming
          ? await reviewMediaTiming({
              kind: 'word',
              text: mediaTimingContext.text,
              startTime: mediaTimingContext.startTime,
              endTime: mediaTimingContext.endTime,
              noteId,
              card: {
                ...(hasExpressionText ? { word: ankiFieldHtmlToPlainText(expressionText) } : {}),
                ...this.getReviewMeaning(noteInfo, config.fields?.definition),
                ...reviewTranslation,
              },
            })
          : ({ action: 'use-original' } as const);
        if ('translation' in timingDecision && timingDecision.translation !== undefined) {
          reviewedTranslation = plainTextToAnkiFieldHtml(timingDecision.translation);
        } else if (reviewTranslation.translation?.fromField) {
          // The review showed the field's own translation and nothing replaced it: keep it
          // as is rather than resolving one the review never showed.
          keepTranslationField = true;
        }
        if (timingDecision.action === 'discard') {
          try {
            await this.deps.client.deleteNotes([noteId]);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.logError('Failed to delete discarded card:', message);
            this.deps.showOsdNotification(`Card deletion failed: ${message}`);
            return;
          }
          this.deps.removeKnownWordNote(noteId);
          this.deps.showOsdNotification('Card deleted.');
          return;
        }
        if (timingDecision.action === 'confirm') {
          skipMedia = timingDecision.skipMedia === true;
          reviewedSentenceText = timingDecision.text?.trim() || undefined;
          if (
            sentenceRange &&
            timingDecision.sentenceStartTime !== undefined &&
            timingDecision.sentenceEndTime !== undefined
          ) {
            sentenceRange = {
              startTime: Math.min(sentenceRange.startTime, timingDecision.sentenceStartTime),
              endTime: Math.max(sentenceRange.endTime, timingDecision.sentenceEndTime),
            };
          }
          mediaTimingContext = {
            ...mediaTimingContext,
            ...(reviewedSentenceText !== undefined ? { text: reviewedSentenceText } : {}),
            startTime: timingDecision.startTime,
            endTime: timingDecision.endTime,
            mediaPaddingSeconds: 0,
            ...(timingDecision.screenshotTime !== undefined
              ? { screenshotTime: timingDecision.screenshotTime }
              : {}),
          };
        } else if (timingDecision.action === 'skip-media') {
          skipMedia = true;
        }
      }

      this.deps.appendKnownWordsFromNoteInfo(noteInfo);

      // A translation from the review belongs to the reviewed sentence.
      let translatedText: string | undefined =
        reviewedTranslation !== undefined ? mediaTimingContext?.text : undefined;
      let translation: string | undefined;
      const minedText = mediaTimingContext?.text ?? this.deps.getCurrentSubtitleText();
      if (translationFieldName && minedText && !keepTranslationField) {
        const parsedTracks = sentenceRange ? await getTracks() : null;
        const timedTranslation = sentenceRange
          ? resolveTimedSentenceTranslation({
              text: minedText,
              ...sentenceRange,
              tracks: parsedTracks,
            })
          : null;
        // A parsed secondary track without a match means no translation; the line on
        // screen only stands in when the tracks are unavailable.
        translation =
          timedTranslation?.translation ??
          (parsedTracks && parsedTracks.secondary.length > 0
            ? undefined
            : getLiveTranslation(minedText));
        if (translation && formatTranslation) {
          translation = formatCardTranslation(translation);
        }
        if (translation) translatedText = minedText;
      }

      const currentSubtitleText =
        reviewedSentenceText ??
        widenedSentenceText ??
        subtitleMiningContext?.text ??
        // The translation belongs to the captured line, so the sentence must be that line too.
        translatedText ??
        this.deps.getCurrentSubtitleText();
      if (sentenceField && currentSubtitleText) {
        const processedSentence = this.deps.processSentence(currentSubtitleText, fields);
        updatedFields[sentenceField] = processedSentence;
        const wordCardKind = resolveWordCardKind(noteInfo, sentenceCardConfig);
        if (wordCardKind) {
          this.deps.setCardTypeFields(updatedFields, Object.keys(noteInfo.fields), wordCardKind);
        }
        updatePerformed = true;
      }
      const sentenceFuriganaField = this.deps.resolveConfiguredFieldName(
        noteInfo,
        'SentenceFurigana',
      );
      const existingSentenceFurigana = sentenceFuriganaField
        ? noteInfo.fields[sentenceFuriganaField]?.value || ''
        : '';
      const sentenceChanged =
        sentenceField &&
        currentSubtitleText &&
        normalizeSubtitleContextText(currentSubtitleText) !==
          normalizeSubtitleContextText(noteInfo.fields[sentenceField]?.value ?? '');
      if (sentenceFuriganaField && sentenceChanged) {
        let furigana: string | null = null;
        try {
          furigana =
            (await this.deps.generateSentenceFurigana?.(currentSubtitleText, fields)) ?? null;
        } catch (error) {
          this.deps.logWarn('Failed to regenerate sentence furigana:', error);
        }
        // Empty furigana lets card templates fall back to the updated Sentence field.
        updatedFields[sentenceFuriganaField] = furigana ?? '';
        updatePerformed = true;
      } else if (
        sentenceFuriganaField &&
        existingSentenceFurigana &&
        this.deps.processSentenceFurigana
      ) {
        const processedSentenceFurigana = this.deps.processSentenceFurigana(
          existingSentenceFurigana,
          fields,
        );
        if (processedSentenceFurigana !== existingSentenceFurigana) {
          updatedFields[sentenceFuriganaField] = processedSentenceFurigana;
          updatePerformed = true;
        }
      }

      // A translation from the review is final, even when cleared.
      const cardTranslation = reviewedTranslation ?? translation;
      if (translationFieldName && (cardTranslation || reviewedTranslation !== undefined)) {
        updatedFields[translationFieldName] = cardTranslation ?? '';
        updatePerformed = true;
      }

      const generateAudio = !skipMedia && config.media?.generateAudio !== false;
      const generateImage = !skipMedia && config.media?.generateImage !== false;
      const mediaCacheQueued =
        (generateAudio || generateImage) && this.deps.queuePendingYoutubeMediaUpdate
          ? await this.deps.queuePendingYoutubeMediaUpdate({
              noteId,
              noteInfo,
              context: mediaTimingContext ?? undefined,
              label: noteLabel,
            })
          : false;

      if (!mediaCacheQueued && generateAudio) {
        try {
          const audioFilename = this.deps.generateAudioFilename();
          const audioBuffer = await this.deps.generateAudio(mediaTimingContext ?? undefined);

          if (audioBuffer) {
            await this.deps.client.storeMediaFile(audioFilename, audioBuffer);
            const sentenceAudioField = this.deps.resolveConfiguredFieldName(
              noteInfo,
              config.fields?.audio ?? DEFAULT_ANKI_CONNECT_CONFIG.fields.audio,
            );
            if (sentenceAudioField) {
              const existingAudio = noteInfo.fields[sentenceAudioField]?.value || '';
              updatedFields[sentenceAudioField] = this.deps.mergeFieldValue(
                existingAudio,
                `[sound:${audioFilename}]`,
                config.behavior?.overwriteAudio !== false,
              );
            }
            miscInfoFilename = audioFilename;
            updatePerformed = true;
          }
        } catch (error) {
          this.deps.logError('Failed to generate audio:', (error as Error).message);
          this.deps.showOsdNotification(`Audio generation failed: ${(error as Error).message}`);
        }
      }

      if (!mediaCacheQueued && generateImage) {
        try {
          const animatedLeadInSeconds = await this.deps.getAnimatedImageLeadInSeconds(noteInfo);
          const imageFilename = this.deps.generateImageFilename();
          const imageBuffer = await this.deps.generateImage(
            animatedLeadInSeconds,
            mediaTimingContext ?? undefined,
          );

          if (imageBuffer) {
            await this.deps.client.storeMediaFile(imageFilename, imageBuffer);
            const imageFieldName = this.deps.resolveConfiguredFieldName(
              noteInfo,
              config.fields?.image,
              DEFAULT_ANKI_CONNECT_CONFIG.fields.image,
            );
            if (!imageFieldName) {
              this.deps.logWarn('Image field not found on note, skipping image update');
            } else {
              const existingImage = noteInfo.fields[imageFieldName]?.value || '';
              updatedFields[imageFieldName] = this.deps.mergeFieldValue(
                existingImage,
                `<img src="${imageFilename}">`,
                config.behavior?.overwriteImage !== false,
              );
              miscInfoFilename = imageFilename;
              updatePerformed = true;
            }
          }
        } catch (error) {
          this.deps.logError('Failed to generate image:', (error as Error).message);
          this.deps.showOsdNotification(`Image generation failed: ${(error as Error).message}`);
        }
      }

      if (!mediaCacheQueued && config.fields?.miscInfo) {
        const miscInfo = this.deps.formatMiscInfoPattern(
          miscInfoFilename || '',
          mediaTimingContext?.startTime ?? this.deps.getCurrentSubtitleStart(),
        );
        const miscInfoField = this.deps.resolveConfiguredFieldName(
          noteInfo,
          config.fields?.miscInfo,
        );
        if (miscInfo && miscInfoField) {
          updatedFields[miscInfoField] = miscInfo;
          updatePerformed = true;
        }
      }

      if (updatePerformed) {
        await this.deps.client.updateNoteFields(noteId, updatedFields);
        await this.deps.addConfiguredTagsToNote(noteId);
        this.deps.logInfo('Updated card fields for:', noteLabel);
        await this.deps.showNotification(noteId, noteLabel);
      }

      if (shouldRunFieldGrouping && hasExpressionText && duplicateNoteId !== null) {
        let noteInfoForGrouping = noteInfo;
        if (updatePerformed) {
          const refreshedInfoResult = await this.deps.client.notesInfo([noteId]);
          const refreshedInfo = refreshedInfoResult as NoteUpdateWorkflowNoteInfo[];
          if (!refreshedInfo || refreshedInfo.length === 0) {
            this.deps.logWarn('Card not found after update:', noteId);
            return;
          }
          noteInfoForGrouping = refreshedInfo[0]!;
        }

        if (sentenceCardConfig.fieldGroupingMode === 'auto') {
          await this.deps.handleFieldGroupingAuto(
            duplicateNoteId,
            noteId,
            noteInfoForGrouping,
            expressionText,
          );
          return;
        }
        if (sentenceCardConfig.fieldGroupingMode === 'manual') {
          await this.deps.handleFieldGroupingManual(
            duplicateNoteId,
            noteId,
            noteInfoForGrouping,
            expressionText,
          );
        }
      }
    } catch (error) {
      if ((error as Error).message.includes('note was not found')) {
        this.deps.logWarn('Card was deleted before update:', noteId);
      } else {
        this.deps.logError('Error processing new card:', (error as Error).message);
      }
    } finally {
      this.deps.endUpdateProgress();
    }
  }
}
