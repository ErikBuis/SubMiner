import assert from 'node:assert/strict';
import test from 'node:test';

import { CardCreationService } from './card-creation';
import {
  type CardCreationDeps,
  createAnkiConfig,
  createCardCreationDeps,
  createFakeClient,
  createFakeMediaGenerator,
} from './card-creation-test-utils';
import { toMpvEdlValue } from './mpv-edl-test-utils';
import type { MediaInput } from '../media-generator';

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=abc123';

const mediaInputPath = (mediaInput: MediaInput): string =>
  typeof mediaInput === 'string' ? mediaInput : mediaInput.path;

test('CardCreationService counts locally created sentence cards', async () => {
  const minedCards: Array<{ count: number; noteIds?: number[] }> = [];
  const service = new CardCreationService(
    createCardCreationDeps({
      recordCardsMinedCallback: (count, noteIds) => {
        minedCards.push({ count, noteIds });
      },
    }),
  );

  assert.equal(await service.createSentenceCard('テスト', 0, 1), true);
  assert.deepEqual(minedCards, [{ count: 1, noteIds: [42] }]);
});

const THROWING_HOOKS: Array<{
  name: string;
  hook: Partial<CardCreationDeps>;
}> = [
  {
    name: 'trackLastAddedNoteId',
    hook: {
      trackLastAddedNoteId: () => {
        throw new Error('track failed');
      },
    },
  },
  {
    name: 'recordCardsMinedCallback',
    hook: {
      recordCardsMinedCallback: () => {
        throw new Error('record failed');
      },
    },
  },
];

for (const c of THROWING_HOOKS) {
  test(`CardCreationService keeps updating after ${c.name} throws`, async () => {
    const calls = { notesInfo: 0, updateNoteFields: 0 };
    const service = new CardCreationService(
      createCardCreationDeps({
        client: createFakeClient({
          notesInfo: async () => {
            calls.notesInfo += 1;
            return [{ noteId: 42, fields: { Sentence: { value: 'existing' } } }];
          },
          updateNoteFields: async () => {
            calls.updateNoteFields += 1;
          },
        }),
        setCardTypeFields: (updatedFields) => {
          updatedFields.CardType = 'sentence';
        },
        ...c.hook,
      }),
    );

    assert.equal(await service.createSentenceCard('テスト', 0, 1), true);
    assert.equal(calls.notesInfo, 1);
    assert.equal(calls.updateNoteFields, 1);
  });
}

test('CardCreationService uses stream-open-filename for remote media generation', async () => {
  let reviewing = false;
  const audioRanges: number[][] = [];
  const imageTimes: number[] = [];
  const audioPaths: string[] = [];
  const imagePaths: string[] = [];
  const audioUrl = 'https://audio.example/videoplayback?mime=audio%2Fwebm';
  const videoUrl = 'https://video.example/videoplayback?mime=video%2Fmp4';
  const edlSource = [
    `edl://!new_stream;!no_clip;!no_chapters;${toMpvEdlValue(audioUrl)}`,
    `!new_stream;!no_clip;!no_chapters;${toMpvEdlValue(videoUrl)}`,
    '!global_tags,title=test',
  ].join(';');

  const service = new CardCreationService(
    createCardCreationDeps({
      getConfig: () =>
        createAnkiConfig({
          fields: { image: 'Picture' },
          media: { generateAudio: true, generateImage: true, imageFormat: 'jpg' },
        }),
      reviewMediaTiming: async () =>
        reviewing
          ? { action: 'confirm', startTime: 0.2, endTime: 0.8, screenshotTime: 3.125 }
          : { action: 'use-original' },
      getMpvClient: () =>
        ({
          currentVideoPath: YOUTUBE_URL,
          currentSubText: '字幕',
          currentSubStart: 1,
          currentSubEnd: 2,
          currentTimePos: 1.5,
          currentAudioStreamIndex: 0,
          requestProperty: async (name: string) => {
            assert.equal(name, 'stream-open-filename');
            return edlSource;
          },
        }) as never,
      client: createFakeClient({
        notesInfo: async () => [
          {
            noteId: 42,
            fields: {
              Sentence: { value: '' },
              SentenceAudio: { value: '' },
              Picture: { value: '' },
            },
          },
        ],
        findNotes: async () => [42],
      }),
      mediaGenerator: createFakeMediaGenerator({
        generateAudio: async (path, start, end, padding) => {
          audioRanges.push([start, end, padding ?? -1]);
          audioPaths.push(mediaInputPath(path));
          return Buffer.from('audio');
        },
        generateScreenshot: async (path, timestamp) => {
          imageTimes.push(timestamp);
          imagePaths.push(mediaInputPath(path));
          return Buffer.from('image');
        },
      }),
    }),
  );

  assert.equal(await service.createSentenceCard('テスト', 0, 1), true);
  assert.deepEqual(audioPaths, [audioUrl]);
  assert.deepEqual(imagePaths, [videoUrl]);

  reviewing = true;
  assert.equal(await service.createSentenceCard('テスト', 0, 1), true);
  assert.deepEqual(audioRanges.at(-1), [0.2, 0.8, 0]);
  assert.equal(imageTimes.at(-1), 3.125);

  await service.markLastCardAsAudioCard();
  assert.equal(imageTimes.length, 3);
  assert.deepEqual(audioRanges.at(-1), [0.2, 0.8, 0]);
  assert.equal(imageTimes.at(-1), 3.125);
});

test('CardCreationService does not use mpv stream indexes for ready cached YouTube media', async () => {
  const audioCalls: Array<{ path: string; audioStreamIndex?: number }> = [];

  const service = new CardCreationService(
    createCardCreationDeps({
      getConfig: () =>
        createAnkiConfig({
          fields: { image: 'Picture' },
          media: { generateAudio: true, imageFormat: 'jpg' },
        }),
      getMpvClient: () =>
        ({
          currentVideoPath: YOUTUBE_URL,
          currentSubText: '字幕',
          currentSubStart: 10,
          currentSubEnd: 12,
          currentTimePos: 11,
          currentAudioStreamIndex: 0,
        }) as never,
      getCachedMediaPath: async () => '/tmp/subminer-youtube-media-cache/media.mkv',
      shouldRequireRemoteMediaCache: () => true,
      client: createFakeClient({
        notesInfo: async () => [
          {
            noteId: 42,
            fields: {
              Sentence: { value: '' },
              SentenceAudio: { value: '' },
              Picture: { value: '' },
            },
          },
        ],
      }),
      mediaGenerator: createFakeMediaGenerator({
        generateAudio: async (path, _startTime, _endTime, _padding, audioStreamIndex) => {
          audioCalls.push({ path: mediaInputPath(path), audioStreamIndex });
          return Buffer.from('audio');
        },
      }),
    }),
  );

  assert.equal(await service.createSentenceCard('テスト', 10, 12), true);
  assert.deepEqual(audioCalls, [
    { path: '/tmp/subminer-youtube-media-cache/media.mkv', audioStreamIndex: undefined },
  ]);
});

test('CardCreationService queues YouTube media when required cache is not ready', async () => {
  const mediaCalls: string[] = [];
  const updates: Array<{ noteId: number; fields: Record<string, string> }> = [];
  const queuedUpdates: Array<{
    sourceUrl: string;
    noteId: number;
    startTime: number;
    endTime: number;
    label: string | number;
    audioFieldName?: string;
    imageFieldName?: string;
    miscInfoFieldName?: string;
    generateAudio: boolean;
    generateImage: boolean;
    volumeScale?: number;
  }> = [];
  let streamRequests = 0;

  const service = new CardCreationService(
    createCardCreationDeps({
      getConfig: () =>
        createAnkiConfig({
          fields: { image: 'Picture', miscInfo: 'MiscInfo' },
          media: { generateAudio: true, generateImage: true, imageFormat: 'jpg' },
        }),
      getMpvClient: () =>
        ({
          currentVideoPath: YOUTUBE_URL,
          currentSubText: '字幕',
          currentSubStart: 10,
          currentSubEnd: 12,
          currentTimePos: 11,
          currentAudioStreamIndex: 2,
          requestProperty: async (name: string) => {
            if (name === 'volume') return 35;
            streamRequests += 1;
            return 'https://rr1---sn.example.googlevideo.com/videoplayback?id=123';
          },
        }) as never,
      getCachedMediaPath: async () => null,
      shouldRequireRemoteMediaCache: () => true,
      queuePendingYoutubeMediaUpdate: (job) => {
        queuedUpdates.push(job);
      },
      client: createFakeClient({
        notesInfo: async () => [
          {
            noteId: 42,
            fields: {
              Sentence: { value: '' },
              SentenceAudio: { value: '' },
              Picture: { value: '' },
              MiscInfo: { value: '' },
            },
          },
        ],
        updateNoteFields: async (noteId, fields) => {
          updates.push({ noteId, fields });
        },
      }),
      mediaGenerator: createFakeMediaGenerator({
        generateAudio: async () => {
          mediaCalls.push('audio');
          return Buffer.from('audio');
        },
        generateScreenshot: async () => {
          mediaCalls.push('image');
          return Buffer.from('image');
        },
      }),
    }),
  );

  assert.equal(await service.createSentenceCard('テスト', 10, 12), true);
  assert.equal(streamRequests, 0);
  assert.deepEqual(mediaCalls, []);
  assert.deepEqual(queuedUpdates, [
    {
      sourceUrl: YOUTUBE_URL,
      noteId: 42,
      startTime: 10,
      endTime: 12,
      label: 'テスト',
      audioFieldName: 'SentenceAudio',
      imageFieldName: 'Picture',
      miscInfoFieldName: 'MiscInfo',
      generateAudio: true,
      generateImage: true,
      volumeScale: 0.35 ** 3,
    },
  ]);
  assert.deepEqual(updates, []);
});

const DUPLICATE_TRACKING_CASES = [
  {
    name: 'tracks sorted, deduplicated pre-add duplicate note ids for kiku sentence cards',
    sentence: '重複文',
    lookupResult: [18, 7, 30, 7],
    expected: [{ noteId: 42, duplicateNoteIds: [7, 18, 30] }],
  },
  {
    name: 'does not track duplicate ids when pre-add lookup returns none',
    sentence: '重複なし',
    lookupResult: [],
    expected: [],
  },
];

for (const c of DUPLICATE_TRACKING_CASES) {
  test(`CardCreationService ${c.name}`, async () => {
    const trackedDuplicates: Array<{ noteId: number; duplicateNoteIds: number[] }> = [];
    const lookedUp: string[] = [];
    const service = new CardCreationService(
      createCardCreationDeps({
        getConfig: () => createAnkiConfig({ fields: { word: 'Expression' } }),
        getEffectiveSentenceCardConfig: () => ({
          model: 'Sentence',
          sentenceField: 'Sentence',
          audioField: 'SentenceAudio',
          lapisEnabled: false,
          kikuEnabled: true,
          fieldGroupingMode: 'manual',
        }),
        findDuplicateNoteIds: async (expression) => {
          lookedUp.push(expression);
          return c.lookupResult;
        },
        trackLastAddedDuplicateNoteIds: (noteId, duplicateNoteIds) => {
          trackedDuplicates.push({ noteId, duplicateNoteIds });
        },
      }),
    );

    assert.equal(await service.createSentenceCard(c.sentence, 0, 1), true);
    assert.deepEqual(lookedUp, [c.sentence]);
    assert.deepEqual(trackedDuplicates, c.expected);
  });
}

function createTimedTranslationService(
  options: {
    tracks?: {
      primary: Array<{ text: string; startTime: number; endTime: number }>;
      secondary: Array<{ text: string; startTime: number; endTime: number }>;
    } | null;
    maxMediaDuration?: number;
  } = {},
) {
  const addedFields: Array<Record<string, string>> = [];
  const service = new CardCreationService(
    createCardCreationDeps({
      getConfig: () =>
        createAnkiConfig({
          fields: { translation: 'Translation' },
          ...(options.maxMediaDuration !== undefined
            ? { media: { maxMediaDuration: options.maxMediaDuration } }
            : {}),
        }),
      getSubtitleTracksForTranslation: () => options.tracks ?? null,
      client: createFakeClient({
        addNote: async (_deck, _model, fields) => {
          addedFields.push(fields);
          return 42;
        },
      }),
    }),
  );
  return { service, addedFields };
}

test('createSentenceCard picks the translation by timing, not the overlapping on-screen line', async () => {
  // Bocchi the Rock! ep. 1 around 00:37: a TV line overlaps the dialogue translation.
  const { service, addedFields } = createTimedTranslationService({
    tracks: {
      primary: [{ text: '野菜もいっぱい入ってるよ', startTime: 36.4, endTime: 39.2 }],
      secondary: [
        { text: "There's a lot of vegetables,", startTime: 34.1, endTime: 37 },
        { text: 'I put lots of vegetables in it.', startTime: 36.3, endTime: 39.4 },
      ],
    },
  });

  assert.equal(
    await service.createSentenceCard(
      '野菜もいっぱい入ってるよ',
      36.4,
      39.2,
      "There's a lot of vegetables,\nI put lots of vegetables in it.",
    ),
    true,
  );
  assert.equal(addedFields[0]?.Sentence, '野菜もいっぱい入ってるよ');
  assert.equal(addedFields[0]?.Translation, 'I put lots of vegetables in it.');
});

test('createSentenceCard keeps the on-screen translation without parsed tracks', async () => {
  const { service, addedFields } = createTimedTranslationService();

  assert.equal(await service.createSentenceCard('今日は', 1, 2, 'Today'), true);
  assert.equal(addedFields[0]?.Translation, 'Today');
});

test('createSentenceCard drops the on-screen line when the parsed track has no match', async () => {
  const { service, addedFields } = createTimedTranslationService({
    tracks: {
      primary: [{ text: '♪～', startTime: 1, endTime: 2 }],
      secondary: [{ text: 'Next line.', startTime: 2.5, endTime: 4 }],
    },
  });

  assert.equal(await service.createSentenceCard('♪～', 1, 2, 'Next line.'), true);
  assert.equal(addedFields[0]?.Translation, undefined);
});

test('createSentenceCard ignores a parsed secondary track in the primary language', async () => {
  const line = { text: '今日は', startTime: 1, endTime: 2 };
  const { service, addedFields } = createTimedTranslationService({
    tracks: { primary: [line], secondary: [line] },
  });

  assert.equal(await service.createSentenceCard('今日は', 1, 2), true);
  assert.equal(addedFields[0]?.Translation, undefined);
});

test('createSentenceCard ignores a same-language track that splits lines differently', async () => {
  const { service, addedFields } = createTimedTranslationService({
    tracks: {
      primary: [
        { text: '今日は', startTime: 1, endTime: 2 },
        { text: 'いい天気ですね', startTime: 2, endTime: 4 },
      ],
      secondary: [{ text: '今日は いい天気ですね', startTime: 1, endTime: 4 }],
    },
  });

  assert.equal(await service.createSentenceCard('いい天気ですね', 2, 4), true);
  assert.equal(addedFields[0]?.Translation, undefined);
});

test('createSentenceCard ignores a shorter same-language cue inside the mined line', async () => {
  const { service, addedFields } = createTimedTranslationService({
    tracks: {
      primary: [{ text: '今日はいい天気ですね', startTime: 1, endTime: 4 }],
      secondary: [
        { text: '今日は', startTime: 1, endTime: 2 },
        { text: 'いい天気ですね', startTime: 2, endTime: 4 },
      ],
    },
  });

  assert.equal(await service.createSentenceCard('今日はいい天気ですね', 1, 4), true);
  assert.equal(addedFields[0]?.Translation, undefined);
});

test('createSentenceCard keeps a bilingual secondary cue', async () => {
  const { service, addedFields } = createTimedTranslationService({
    tracks: {
      primary: [{ text: '今日はいい天気ですね', startTime: 1, endTime: 4 }],
      secondary: [
        { text: '今日はいい天気ですね\nNice weather today, huh?', startTime: 1, endTime: 4 },
      ],
    },
  });

  assert.equal(await service.createSentenceCard('今日はいい天気ですね', 1, 4), true);
  assert.equal(addedFields[0]?.Translation, '今日はいい天気ですね Nice weather today, huh?');
});

test('createSentenceCard keeps a bilingual cue for a sentence with Latin letters', async () => {
  const { service, addedFields } = createTimedTranslationService({
    tracks: {
      primary: [{ text: 'DNAって何？', startTime: 1, endTime: 3 }],
      secondary: [{ text: 'DNAって何？\nWhat is DNA?', startTime: 1, endTime: 3 }],
    },
  });

  assert.equal(await service.createSentenceCard('DNAって何？', 1, 3), true);
  assert.equal(addedFields[0]?.Translation, 'DNAって何？ What is DNA?');
});

test('createSentenceCard keeps a bilingual cue in a script it does not list', async () => {
  const { service, addedFields } = createTimedTranslationService({
    tracks: {
      primary: [{ text: '今日は', startTime: 1, endTime: 3 }],
      secondary: [{ text: '今日は\nהיום', startTime: 1, endTime: 3 }],
    },
  });

  assert.equal(await service.createSentenceCard('今日は', 1, 3), true);
  assert.equal(addedFields[0]?.Translation, '今日は היום');
});

test('createSentenceCard translates every combined line even when the media is capped', async () => {
  const { service, addedFields } = createTimedTranslationService({
    maxMediaDuration: 30,
    tracks: {
      primary: [
        { text: '一', startTime: 0, endTime: 15 },
        { text: '二', startTime: 15, endTime: 30 },
        { text: '三', startTime: 30, endTime: 45 },
      ],
      secondary: [
        { text: 'One.', startTime: 0, endTime: 15 },
        { text: 'Two.', startTime: 15, endTime: 30 },
        { text: 'Three.', startTime: 30, endTime: 45 },
      ],
    },
  });

  assert.equal(await service.createSentenceCard('一 二 三', 0, 45), true);
  assert.equal(addedFields[0]?.Translation, 'One. Two. Three.');
});

test('createSentenceCard translates the lines the timing review added', async () => {
  const addedFields: Array<Record<string, string>> = [];
  const service = new CardCreationService(
    createCardCreationDeps({
      getConfig: () => createAnkiConfig({ fields: { translation: 'Translation' } }),
      getSubtitleTracksForTranslation: () => ({
        primary: [
          { text: '一', startTime: 0, endTime: 2 },
          { text: '二', startTime: 2, endTime: 4 },
        ],
        secondary: [
          { text: 'One.', startTime: 0, endTime: 2 },
          { text: 'Two.', startTime: 2, endTime: 4 },
        ],
      }),
      client: createFakeClient({
        addNote: async (_deck, _model, fields) => {
          addedFields.push(fields);
          return 42;
        },
      }),
      reviewMediaTiming: async () => ({
        action: 'confirm',
        startTime: 0,
        endTime: 3.8,
        text: '一 二',
        sentenceStartTime: 0,
        sentenceEndTime: 4,
      }),
    }),
  );

  assert.equal(await service.createSentenceCard('一', 0, 2), true);
  assert.equal(addedFields[0]?.Sentence, '一 二');
  assert.equal(addedFields[0]?.Translation, 'One. Two.');
});

test('createSentenceCard leaves a line inside the clip padding untranslated', async () => {
  const addedFields: Array<Record<string, string>> = [];
  const service = new CardCreationService(
    createCardCreationDeps({
      getConfig: () => createAnkiConfig({ fields: { translation: 'Translation' } }),
      getSubtitleTracksForTranslation: () => ({
        primary: [
          { text: '一', startTime: 0, endTime: 2 },
          { text: 'え？', startTime: 2, endTime: 2.4 },
        ],
        secondary: [
          { text: 'One.', startTime: 0, endTime: 2 },
          { text: 'Huh?', startTime: 2, endTime: 2.4 },
        ],
      }),
      client: createFakeClient({
        addNote: async (_deck, _model, fields) => {
          addedFields.push(fields);
          return 42;
        },
      }),
      // The confirmed clip keeps its padding past the end of the mined line.
      reviewMediaTiming: async () => ({ action: 'confirm', startTime: 0, endTime: 2.5 }),
    }),
  );

  assert.equal(await service.createSentenceCard('一', 0, 2), true);
  assert.equal(addedFields[0]?.Sentence, '一');
  assert.equal(addedFields[0]?.Translation, 'One.');
});
