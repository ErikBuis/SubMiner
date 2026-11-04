import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveTimedSentenceTranslation,
  widenSentenceToTranslation,
  type SubtitleTracksForTranslation,
} from '../../anki-integration/sentence-translation';
import type { SubtitleMiningContext } from '../../types';
import type { AppState } from '../state';
import { createMiningAssembly, type MiningAssemblyDeps } from './mining';

type AnkiIntegrationLike = NonNullable<AppState['ankiIntegration']>;
type MpvClientLike = NonNullable<AppState['mpvClient']>;

// Every callback throws, so a test fails if the assembly calls a dep it should only call later.
function makeDeps(overrides: Partial<MiningAssemblyDeps> = {}): MiningAssemblyDeps {
  const lazy = (name: string) => (): never => {
    throw new Error(`${name} called unexpectedly`);
  };
  return {
    appState: {
      mpvClient: null,
      currentMediaPath: null,
      activeParsedSubtitleCues: [],
      ankiIntegration: null,
      subtitleTimingTracker: null,
      fieldGroupingResolver: null,
      fieldGroupingResolverSequence: 0,
    },
    getConfig: lazy('getConfig'),
    logger: { warn: lazy('warn'), error: lazy('error') },
    overlayManager: {
      getMainWindow: lazy('getMainWindow'),
      getModalWindow: lazy('getModalWindow'),
      getVisibleOverlayVisible: lazy('getVisibleOverlayVisible'),
    },
    overlayModalRuntime: {
      getRestoreVisibleOverlayOnModalClose: lazy('getRestoreVisibleOverlayOnModalClose'),
      waitForModalOpen: lazy('waitForModalOpen'),
      handleOverlayModalClosed: lazy('handleOverlayModalClosed'),
      sendToActiveOverlayWindow: lazy('sendToActiveOverlayWindow'),
    },
    youtube: {
      getCachedMediaPathForCurrentPlayback: lazy('getCachedMediaPathForCurrentPlayback'),
      shouldRequireMediaCacheForCurrentPlayback: lazy('shouldRequireMediaCacheForCurrentPlayback'),
    },
    clipboard: { readText: lazy('readText'), writeText: lazy('writeText') },
    getOverlayNotifications: lazy('getOverlayNotifications'),
    getOverlayModals: lazy('getOverlayModals'),
    setVisibleOverlayVisible: lazy('setVisibleOverlayVisible'),
    getSecondarySubtitleCues: lazy('getSecondarySubtitleCues'),
    ensureOverlayStartupPrereqs: lazy('ensureOverlayStartupPrereqs'),
    ensureOverlayWindowsReadyForVisibilityActions: lazy(
      'ensureOverlayWindowsReadyForVisibilityActions',
    ),
    ankiIntegrationCallbacks: {
      recordCardsMined: lazy('recordCardsMined'),
      getMiningProvenance: lazy('getMiningProvenance'),
      onCardsReady: lazy('onCardsReady'),
      onKnownWordCacheUpdated: lazy('onKnownWordCacheUpdated'),
      generateSentenceFurigana: lazy('generateSentenceFurigana'),
    },
    ...overrides,
  };
}

const lookupContext: SubtitleMiningContext = {
  source: 'overlay',
  text: '今日はいい天気',
  startTime: 3,
  endTime: 5,
  capturedAtMs: 1,
};

// main.ts builds the assembly before most siblings exist, so construction must stay lazy.
test('createMiningAssembly does not call its deps while constructing', () => {
  const mining = createMiningAssembly(makeDeps());
  assert.equal(typeof mining.mineSentenceCard, 'function');
  assert.equal(typeof mining.attachToAnkiIntegration, 'function');
});

test('a recorded lookup context reaches exactly one mined card', () => {
  let consumeContext: (() => SubtitleMiningContext | null) | null = null;
  const setters: string[] = [];
  const integration = new Proxy(
    {},
    {
      get: (_target, name: string) => (callback: unknown) => {
        setters.push(name);
        if (name === 'setSubtitleMiningContextConsumer') {
          consumeContext = callback as () => SubtitleMiningContext | null;
        }
      },
    },
  ) as AnkiIntegrationLike;
  const mining = createMiningAssembly(makeDeps());

  mining.attachToAnkiIntegration(integration);
  mining.recordSubtitleMiningContext(lookupContext);

  assert.equal(setters.length, 8);
  assert.ok(consumeContext);
  const consume = consumeContext as () => SubtitleMiningContext | null;
  assert.deepEqual(consume(), lookupContext);
  assert.equal(consume(), null);
});

test('mining without parsed cues falls back to the live mpv line on the video clock', () => {
  const mpvClient = {
    currentSubText: 'こんにちは',
    currentSubStart: 10,
    currentSubEnd: 12,
    currentSubDelay: 0.5,
    currentTimePos: 11,
  } as MpvClientLike;
  const mining = createMiningAssembly(
    makeDeps({ appState: { ...makeDeps().appState, mpvClient } }),
  );

  const context = mining.captureCurrentPrimarySubtitleMiningContext();

  assert.equal(context?.text, 'こんにちは');
  assert.equal(context?.startTime, 10.5);
  assert.equal(context?.endTime, 12.5);
});

test('a line mined with sub-delay gets the translation shown beside it', () => {
  // `sub-delay` 2 plays file line 10-12 at 12-14, beside the secondary line 'First line'.
  type TracksProvider = () => SubtitleTracksForTranslation | null;
  let provideTracks: TracksProvider | null = null;
  const integration = new Proxy(
    {},
    {
      get: (_target, name: string) => (callback: unknown) => {
        if (name === 'setSubtitleTracksForTranslationProvider') {
          provideTracks = callback as TracksProvider;
        }
      },
    },
  ) as AnkiIntegrationLike;
  const mpvClient = {
    currentSubText: '一行目',
    currentSubStart: 10,
    currentSubEnd: 12,
    currentSubDelay: 2,
    currentTimePos: 13,
  } as MpvClientLike;
  const mining = createMiningAssembly(
    makeDeps({
      appState: {
        ...makeDeps().appState,
        mpvClient,
        activeParsedSubtitleCues: [
          { text: '一行目', startTime: 10, endTime: 12 },
          { text: '二行目', startTime: 12, endTime: 14 },
        ],
      },
      // The secondary track has no delay of its own: its file times are where mpv plays it.
      getSecondarySubtitleCues: () => [
        { text: 'Line before', startTime: 10, endTime: 12 },
        { text: 'First line', startTime: 12, endTime: 14 },
        { text: 'Second line', startTime: 14, endTime: 16 },
      ],
    }),
  );
  mining.attachToAnkiIntegration(integration);

  const context = mining.captureCurrentPrimarySubtitleMiningContext();
  assert.deepEqual([context?.text, context?.startTime, context?.endTime], ['一行目', 12, 14]);
  assert.ok(provideTracks);
  const tracks = (provideTracks as TracksProvider)();
  assert.equal(
    resolveTimedSentenceTranslation({
      text: context!.text,
      startTime: context!.startTime,
      endTime: context!.endTime,
      tracks,
    })?.translation,
    'First line',
  );
});

test('a sentence widened with sub-delay keeps its media range on the video clock', () => {
  // `sub-delay` 2 plays file lines 10-11 and 11-12 at 12-13 and 13-14, both under one
  // secondary line. Widening the first line must clip 12-14, where mpv plays the sentence.
  type TracksProvider = () => SubtitleTracksForTranslation | null;
  let provideTracks: TracksProvider | null = null;
  const integration = new Proxy(
    {},
    {
      get: (_target, name: string) => (callback: unknown) => {
        if (name === 'setSubtitleTracksForTranslationProvider') {
          provideTracks = callback as TracksProvider;
        }
      },
    },
  ) as AnkiIntegrationLike;
  const mining = createMiningAssembly(
    makeDeps({
      appState: {
        ...makeDeps().appState,
        mpvClient: { currentSubDelay: 2 } as MpvClientLike,
        activeParsedSubtitleCues: [
          { text: '今日は', startTime: 10, endTime: 11 },
          { text: 'いい天気ですね', startTime: 11, endTime: 12 },
        ],
      },
      getSecondarySubtitleCues: () => [
        { text: 'Nice weather today, huh?', startTime: 12, endTime: 14 },
      ],
    }),
  );
  mining.attachToAnkiIntegration(integration);
  assert.ok(provideTracks);

  assert.deepEqual(
    widenSentenceToTranslation({
      text: '今日は',
      startTime: 12,
      endTime: 13,
      tracks: (provideTracks as TracksProvider)(),
      maxSentenceSeconds: 0,
    }),
    { text: '今日は いい天気ですね', startTime: 12, endTime: 14 },
  );
});
