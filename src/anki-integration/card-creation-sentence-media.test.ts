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

test('sentence card writes generated audio only to sentence audio field', async () => {
  const addedFields: Record<string, string>[] = [];
  const updatedFields: Record<string, string>[] = [];
  const storedMedia: string[] = [];
  const requestedProperties: string[] = [];
  const audioVolumeScales: Array<number | undefined> = [];
  const audioRanges: Array<{ start: number; end: number; padding: number | undefined }> = [];
  let review: Awaited<ReturnType<NonNullable<CardCreationDeps['reviewMediaTiming']>>> = {
    action: 'confirm',
    startTime: 11.4,
    endTime: 14.2,
  };

  const service = new CardCreationService(
    createCardCreationDeps({
      getConfig: () =>
        createAnkiConfig({
          fields: {
            word: 'Expression',
            audio: 'ExpressionAudio',
            translation: 'SelectionText',
          },
          media: { generateAudio: true, mirrorMpvVolume: true, maxMediaDuration: 30 },
        }),
      getMpvClient: () =>
        ({
          currentVideoPath: '/video.mp4',
          currentSubText: '字幕',
          currentSubStart: 12,
          currentSubEnd: 14,
          currentTimePos: 13,
          currentAudioStreamIndex: 0,
          requestProperty: async (name: string) => {
            requestedProperties.push(name);
            return 40;
          },
        }) as never,
      client: createFakeClient({
        addNote: async (_deck, _modelName, fields) => {
          addedFields.push(fields);
          return 42;
        },
        notesInfo: async () => [
          {
            noteId: 42,
            fields: {
              Expression: { value: '字幕' },
              Sentence: { value: '字幕' },
              SelectionText: { value: 'Subtitle' },
              ExpressionAudio: { value: '' },
              SentenceAudio: { value: '' },
            },
          },
        ],
        updateNoteFields: async (_noteId, fields) => {
          updatedFields.push(fields);
        },
        storeMediaFile: async (filename) => {
          storedMedia.push(filename);
        },
      }),
      mediaGenerator: createFakeMediaGenerator({
        generateAudio: async (
          _path,
          startTime,
          endTime,
          audioPadding,
          _audioStreamIndex,
          _normalizeAudio,
          volumeScale,
        ) => {
          audioRanges.push({ start: startTime, end: endTime, padding: audioPadding });
          audioVolumeScales.push(volumeScale);
          return Buffer.from('audio');
        },
      }),
      getEffectiveSentenceCardConfig: () => ({
        model: 'Sentence',
        sentenceField: 'Sentence',
        audioField: 'SentenceAudio',
        lapisEnabled: true,
        kikuEnabled: false,
        fieldGroupingMode: 'disabled',
      }),
      reviewMediaTiming: async () => review,
    }),
  );

  assert.equal(await service.createSentenceCard('字幕', 12, 14, 'Subtitle'), true);
  assert.deepEqual(addedFields[0], {
    Sentence: '字幕',
    SelectionText: 'Subtitle',
    IsSentenceCard: 'x',
    Expression: '字幕',
  });
  assert.equal(storedMedia.length, 1);
  assert.deepEqual(requestedProperties, ['volume']);
  assert.deepEqual(audioVolumeScales, [0.4 ** 3]);
  assert.deepEqual(audioRanges, [{ start: 11.4, end: 14.2, padding: 0 }]);
  const mediaUpdate = updatedFields.find((fields) => 'SentenceAudio' in fields);
  assert.equal(mediaUpdate?.SentenceAudio, `[sound:${storedMedia[0]}]`);
  assert.equal('ExpressionAudio' in mediaUpdate!, false);

  review = { action: 'discard' };
  assert.equal(await service.createSentenceCard('作らない', 20, 22), false);
  assert.equal(addedFields.length, 1);

  review = { action: 'skip-media' };
  assert.equal(await service.createSentenceCard('メディアなし', 30, 32), true);
  assert.equal(addedFields.length, 2);
  assert.equal(storedMedia.length, 1);
  assert.deepEqual(audioRanges, [{ start: 11.4, end: 14.2, padding: 0 }]);
  assert.deepEqual(requestedProperties, ['volume']);
});

function createFieldMappingService(options: {
  lapisEnabled: boolean;
  modelFields: string[] | Error;
  modelFieldCalls?: Array<{ model: string; options?: { maxRetries?: number } }>;
}) {
  const addedFields: Record<string, string>[] = [];
  const updatedFields: Record<string, string>[] = [];
  const noteFields = Object.fromEntries(
    (options.modelFields instanceof Error ? ['Kanji', 'Audio'] : options.modelFields).map(
      (name) => [name, { value: '' }],
    ),
  );
  const service = new CardCreationService(
    createCardCreationDeps({
      getConfig: () =>
        createAnkiConfig({
          fields: { sentence: 'Kanji', audio: 'Audio', translation: 'Translation' },
          media: { generateAudio: true, mirrorMpvVolume: false },
        }),
      client: createFakeClient({
        modelFieldNames: async (model, fieldOptions) => {
          options.modelFieldCalls?.push({ model, options: fieldOptions });
          if (options.modelFields instanceof Error) throw options.modelFields;
          return options.modelFields;
        },
        addNote: async (_deck, _model, fields) => {
          addedFields.push(fields);
          return 42;
        },
        notesInfo: async () => [{ noteId: 42, fields: noteFields }],
        updateNoteFields: async (_noteId, fields) => {
          updatedFields.push(fields);
        },
      }),
      mediaGenerator: createFakeMediaGenerator({
        generateAudio: async () => Buffer.from('audio'),
      }),
      getEffectiveSentenceCardConfig: () => ({
        model: 'Mining',
        sentenceField: 'Sentence',
        audioField: 'SentenceAudio',
        lapisEnabled: options.lapisEnabled,
        kikuEnabled: false,
        fieldGroupingMode: 'disabled',
      }),
    }),
  );
  const audioUpdate = () =>
    updatedFields.find((fields) => Object.values(fields).some((v) => v.startsWith('[sound:')));
  return { service, addedFields, audioUpdate };
}

test('sentence card on another note type writes to the configured sentence and audio fields', async () => {
  const modelFieldCalls: Array<{ model: string; options?: { maxRetries?: number } }> = [];
  const { service, addedFields, audioUpdate } = createFieldMappingService({
    lapisEnabled: false,
    modelFields: ['Furigana', 'kanji', 'Audio', 'Translation'],
    modelFieldCalls,
  });

  assert.equal(await service.createSentenceCard('字幕', 1, 2, 'Subtitle'), true);
  assert.deepEqual(addedFields[0], { kanji: '字幕', Translation: 'Subtitle' });
  assert.deepEqual(Object.keys(audioUpdate() ?? {}), ['Audio']);
  assert.deepEqual(modelFieldCalls, [{ model: 'Mining', options: { maxRetries: 0 } }]);
});

test('sentence card falls back to Sentence and SentenceAudio when the note type lacks the configured fields', async () => {
  const { service, addedFields, audioUpdate } = createFieldMappingService({
    lapisEnabled: false,
    modelFields: ['Expression', 'Sentence', 'SentenceAudio'],
  });

  assert.equal(await service.createSentenceCard('字幕', 1, 2), true);
  assert.deepEqual(addedFields[0], { Sentence: '字幕' });
  assert.deepEqual(Object.keys(audioUpdate() ?? {}), ['SentenceAudio']);
});

test('Lapis sentence card keeps Sentence and SentenceAudio when the note type has both', async () => {
  const { service, addedFields, audioUpdate } = createFieldMappingService({
    lapisEnabled: true,
    modelFields: ['Expression', 'Sentence', 'SentenceAudio', 'Kanji', 'Audio'],
  });

  assert.equal(await service.createSentenceCard('字幕', 1, 2), true);
  assert.equal(addedFields[0]?.Sentence, '字幕');
  assert.equal('Kanji' in addedFields[0]!, false);
  assert.deepEqual(Object.keys(audioUpdate() ?? {}), ['SentenceAudio']);
});

test('sentence card uses the configured fields when Anki cannot list the note type fields', async () => {
  const { service, addedFields, audioUpdate } = createFieldMappingService({
    lapisEnabled: false,
    modelFields: new Error('connect ECONNREFUSED 127.0.0.1:8765'),
  });

  assert.equal(await service.createSentenceCard('字幕', 1, 2), true);
  assert.deepEqual(addedFields[0], { Kanji: '字幕' });
  assert.deepEqual(Object.keys(audioUpdate() ?? {}), ['Audio']);
});
