import assert from 'node:assert/strict';
import test from 'node:test';

import { CardCreationService } from './card-creation';
import {
  type CardCreationDeps,
  createAnkiConfig,
  createCardCreationDeps,
  createFakeClient,
} from './card-creation-test-utils';

type FuriganaCall = { text: string; noteFields?: Record<string, string> };

function createSentenceCardService(options: {
  noteFields: string[];
  updates: Array<Record<string, string>>;
  calls?: FuriganaCall[];
  fields?: Record<string, string>;
  generateSentenceFurigana?: CardCreationDeps['generateSentenceFurigana'];
}): CardCreationService {
  return new CardCreationService(
    createCardCreationDeps({
      getConfig: () => createAnkiConfig({ fields: options.fields }),
      client: createFakeClient({
        notesInfo: async () => [
          {
            noteId: 42,
            fields: Object.fromEntries(options.noteFields.map((name) => [name, { value: '' }])),
          },
        ],
        updateNoteFields: async (_noteId, fields) => {
          options.updates.push(fields);
        },
      }),
      generateSentenceFurigana:
        options.generateSentenceFurigana ??
        (async (text, noteFields) => {
          options.calls?.push({ text, noteFields });
          return ' 猫[ねこ]を 見[み]た。';
        }),
    }),
  );
}

test('sentence card writes generated furigana for its sentence', async () => {
  const updates: Array<Record<string, string>> = [];
  const calls: FuriganaCall[] = [];
  const service = createSentenceCardService({
    noteFields: ['Sentence', 'SentenceFurigana', 'SentenceAudio'],
    updates,
    calls,
  });

  assert.equal(await service.createSentenceCard('猫を見た。', 0, 1), true);

  assert.deepEqual(calls, [{ text: '猫を見た。', noteFields: undefined }]);
  assert.deepEqual(updates, [{ SentenceFurigana: ' 猫[ねこ]を 見[み]た。' }]);
});

test('sentence card writes furigana to the configured sentenceFurigana field', async () => {
  const updates: Array<Record<string, string>> = [];
  const service = createSentenceCardService({
    fields: { sentenceFurigana: 'Furigana' },
    noteFields: ['Sentence', 'Furigana', 'SentenceFurigana'],
    updates,
  });

  assert.equal(await service.createSentenceCard('猫を見た。', 0, 1), true);

  assert.deepEqual(updates, [{ Furigana: ' 猫[ねこ]を 見[み]た。' }]);
});

test('sentence card skips furigana when the note has no furigana field', async () => {
  const updates: Array<Record<string, string>> = [];
  const calls: FuriganaCall[] = [];
  const service = createSentenceCardService({
    noteFields: ['Sentence', 'SentenceAudio'],
    updates,
    calls,
  });

  assert.equal(await service.createSentenceCard('猫を見た。', 0, 1), true);

  assert.deepEqual(calls, []);
  assert.deepEqual(updates, []);
});

for (const [name, generateSentenceFurigana] of [
  ['finds no full parse', async () => null],
  [
    'throws',
    async () => {
      throw new Error('parser unavailable');
    },
  ],
] as const) {
  test(`sentence card leaves the furigana field empty when the parser ${name}`, async () => {
    const updates: Array<Record<string, string>> = [];
    const notifications: Array<string | undefined> = [];
    const service = new CardCreationService(
      createCardCreationDeps({
        client: createFakeClient({
          notesInfo: async () => [
            { noteId: 42, fields: { Sentence: { value: '' }, SentenceFurigana: { value: '' } } },
          ],
          updateNoteFields: async (_noteId, fields) => {
            updates.push(fields);
          },
        }),
        showNotification: async (_noteId, _label, errorSuffix) => {
          notifications.push(errorSuffix);
        },
        generateSentenceFurigana,
      }),
    );

    assert.equal(await service.createSentenceCard('猫を見た。', 0, 1), true);

    assert.deepEqual(updates, []);
    assert.deepEqual(notifications, [undefined]);
  });
}

test('sentence card generates furigana for the sentence the review confirmed', async () => {
  const updates: Array<Record<string, string>> = [];
  const calls: FuriganaCall[] = [];
  const service = new CardCreationService(
    createCardCreationDeps({
      client: createFakeClient({
        notesInfo: async () => [
          { noteId: 42, fields: { Sentence: { value: '' }, SentenceFurigana: { value: '' } } },
        ],
        updateNoteFields: async (_noteId, fields) => {
          updates.push(fields);
        },
      }),
      reviewMediaTiming: async () => ({
        action: 'confirm',
        startTime: 0,
        endTime: 2,
        text: '猫を見た。\n犬もいた。',
      }),
      generateSentenceFurigana: async (text, noteFields) => {
        calls.push({ text, noteFields });
        return '[furigana]';
      },
    }),
  );

  assert.equal(await service.createSentenceCard('猫を見た。', 0, 1), true);

  assert.deepEqual(calls, [{ text: '猫を見た。\n犬もいた。', noteFields: undefined }]);
  assert.deepEqual(updates[0], { SentenceFurigana: '[furigana]' });
});

function createAudioCardService(options: {
  noteFields: Record<string, string>;
  updates: Array<Record<string, string>>;
  calls?: FuriganaCall[];
  fields?: Record<string, string>;
  reviewText?: string;
  generateSentenceFurigana?: CardCreationDeps['generateSentenceFurigana'];
}): CardCreationService {
  return new CardCreationService(
    createCardCreationDeps({
      getConfig: () => createAnkiConfig({ fields: options.fields }),
      client: createFakeClient({
        findNotes: async () => [42],
        notesInfo: async () => [
          {
            noteId: 42,
            fields: Object.fromEntries(
              Object.entries(options.noteFields).map(([name, value]) => [name, { value }]),
            ),
          },
        ],
        updateNoteFields: async (_noteId, fields) => {
          options.updates.push(fields);
        },
      }),
      extractFields: (fields) =>
        Object.fromEntries(
          Object.entries(fields).map(([name, { value }]) => [name.toLowerCase(), value]),
        ),
      ...(options.reviewText === undefined
        ? {}
        : {
            reviewMediaTiming: async () => ({
              action: 'confirm' as const,
              startTime: 1,
              endTime: 2,
              text: options.reviewText,
            }),
          }),
      generateSentenceFurigana:
        options.generateSentenceFurigana ??
        (async (text, noteFields) => {
          options.calls?.push({ text, noteFields });
          return ' 字幕[じまく]';
        }),
    }),
  );
}

test('audio card regenerates furigana for the new sentence, bolding the word', async () => {
  const updates: Array<Record<string, string>> = [];
  const calls: FuriganaCall[] = [];
  const service = createAudioCardService({
    noteFields: {
      Expression: '猫',
      Sentence: '<b>猫</b>を見た。',
      SentenceFurigana: '<b> 猫[ねこ]</b>を 見[み]た。',
    },
    updates,
    calls,
  });

  await service.markLastCardAsAudioCard();

  assert.deepEqual(calls, [
    {
      text: '字幕',
      noteFields: {
        expression: '猫',
        sentence: '<b>猫</b>を見た。',
        sentencefurigana: '<b> 猫[ねこ]</b>を 見[み]た。',
      },
    },
  ]);
  assert.equal(updates[0]?.Sentence, '字幕');
  assert.equal(updates[0]?.SentenceFurigana, ' 字幕[じまく]');
});

test('audio card uses the sentence the review confirmed for its furigana', async () => {
  const updates: Array<Record<string, string>> = [];
  const calls: FuriganaCall[] = [];
  const service = createAudioCardService({
    noteFields: { Sentence: '前の文。', SentenceFurigana: ' 前[まえ]の 文[ぶん]。' },
    updates,
    calls,
    reviewText: '字幕\n次の行',
  });

  await service.markLastCardAsAudioCard();

  assert.equal(calls[0]?.text, '字幕\n次の行');
  assert.equal(updates[0]?.SentenceFurigana, ' 字幕[じまく]');
});

test('audio card keeps the furigana when the sentence did not change', async () => {
  const updates: Array<Record<string, string>> = [];
  const calls: FuriganaCall[] = [];
  const service = createAudioCardService({
    noteFields: { Sentence: '<b>字幕</b>', SentenceFurigana: '<b> 字幕[じまく]</b>' },
    updates,
    calls,
  });

  await service.markLastCardAsAudioCard();

  assert.deepEqual(calls, []);
  assert.equal('SentenceFurigana' in (updates[0] ?? {}), false);
});

test('audio card matches the note sentence field case-insensitively', async () => {
  const updates: Array<Record<string, string>> = [];
  const calls: FuriganaCall[] = [];
  const defaults = createCardCreationDeps();
  const service = new CardCreationService(
    createCardCreationDeps({
      client: createFakeClient({
        findNotes: async () => [42],
        notesInfo: async () => [
          {
            noteId: 42,
            fields: { sentence: { value: '<b>字幕</b>' }, SentenceFurigana: { value: 'kept' } },
          },
        ],
        updateNoteFields: async (_noteId, fields) => {
          updates.push(fields);
        },
      }),
      resolveNoteFieldName: (noteInfo, preferredName) =>
        Object.keys(noteInfo.fields).find(
          (name) => name.toLowerCase() === preferredName?.toLowerCase(),
        ) ?? defaults.resolveNoteFieldName(noteInfo, preferredName),
      generateSentenceFurigana: async (text, noteFields) => {
        calls.push({ text, noteFields });
        return 'regenerated';
      },
    }),
  );

  await service.markLastCardAsAudioCard();

  assert.deepEqual(calls, []);
  assert.equal('SentenceFurigana' in (updates[0] ?? {}), false);
});

test('audio card writes furigana to the configured sentenceFurigana field', async () => {
  const updates: Array<Record<string, string>> = [];
  const service = createAudioCardService({
    fields: { sentenceFurigana: 'Furigana' },
    noteFields: { Sentence: '前の文。', Furigana: '前の文。', SentenceFurigana: '' },
    updates,
  });

  await service.markLastCardAsAudioCard();

  assert.equal(updates[0]?.Furigana, ' 字幕[じまく]');
  assert.equal('SentenceFurigana' in (updates[0] ?? {}), false);
});

test('audio card clears stale furigana when the parser cannot read the new sentence', async () => {
  const updates: Array<Record<string, string>> = [];
  const service = createAudioCardService({
    noteFields: { Sentence: '前の文。', SentenceFurigana: ' 前[まえ]の 文[ぶん]。' },
    updates,
    generateSentenceFurigana: async () => {
      throw new Error('parser unavailable');
    },
  });

  await service.markLastCardAsAudioCard();

  assert.equal(updates[0]?.Sentence, '字幕');
  assert.equal(updates[0]?.SentenceFurigana, '');
});

test('audio card leaves a note without a furigana field alone', async () => {
  const updates: Array<Record<string, string>> = [];
  const calls: FuriganaCall[] = [];
  const service = createAudioCardService({
    noteFields: { Sentence: '前の文。' },
    updates,
    calls,
  });

  await service.markLastCardAsAudioCard();

  assert.deepEqual(calls, []);
  assert.deepEqual(updates, [{ Sentence: '字幕' }]);
});

function createClipboardUpdateService(options: {
  noteFields: Record<string, string>;
  updates: Array<Record<string, string>>;
  calls?: FuriganaCall[];
  fields?: Record<string, string>;
  generateSentenceFurigana?: CardCreationDeps['generateSentenceFurigana'];
}): CardCreationService {
  return new CardCreationService(
    createCardCreationDeps({
      getConfig: () => createAnkiConfig({ fields: options.fields }),
      getTimingTracker: () =>
        ({
          findTiming: (text: string) =>
            text === '字幕' || text === '次の行' ? { startTime: 12, endTime: 14 } : null,
        }) as never,
      client: createFakeClient({
        findNotes: async () => [42],
        notesInfo: async () => [
          {
            noteId: 42,
            fields: Object.fromEntries(
              Object.entries(options.noteFields).map(([name, value]) => [name, { value }]),
            ),
          },
        ],
        updateNoteFields: async (_noteId, fields) => {
          options.updates.push(fields);
        },
      }),
      extractFields: (fields) =>
        Object.fromEntries(
          Object.entries(fields).map(([name, { value }]) => [name.toLowerCase(), value]),
        ),
      generateSentenceFurigana:
        options.generateSentenceFurigana ??
        (async (text, noteFields) => {
          options.calls?.push({ text, noteFields });
          return ' 字幕[じまく]';
        }),
    }),
  );
}

test('clipboard update regenerates furigana for the pasted sentence, bolding the word', async () => {
  const updates: Array<Record<string, string>> = [];
  const calls: FuriganaCall[] = [];
  const service = createClipboardUpdateService({
    noteFields: {
      Expression: '猫',
      Sentence: '<b>猫</b>を見た。',
      SentenceFurigana: '<b> 猫[ねこ]</b>を 見[み]た。',
    },
    updates,
    calls,
  });

  await service.updateLastAddedFromClipboard('字幕');

  assert.deepEqual(calls, [
    {
      text: '字幕',
      noteFields: {
        expression: '猫',
        sentence: '<b>猫</b>を見た。',
        sentencefurigana: '<b> 猫[ねこ]</b>を 見[み]た。',
      },
    },
  ]);
  assert.equal(updates[0]?.Sentence, '字幕');
  assert.equal(updates[0]?.SentenceFurigana, ' 字幕[じまく]');
});

test('clipboard update generates furigana for all pasted lines joined', async () => {
  const updates: Array<Record<string, string>> = [];
  const calls: FuriganaCall[] = [];
  const service = createClipboardUpdateService({
    noteFields: { Sentence: '前の文。', SentenceFurigana: ' 前[まえ]の 文[ぶん]。' },
    updates,
    calls,
  });

  await service.updateLastAddedFromClipboard('字幕\n\n次の行');

  assert.equal(calls[0]?.text, '字幕 次の行');
  assert.equal(updates[0]?.SentenceFurigana, ' 字幕[じまく]');
});

test('clipboard update keeps the furigana when the sentence did not change', async () => {
  const updates: Array<Record<string, string>> = [];
  const calls: FuriganaCall[] = [];
  const service = createClipboardUpdateService({
    noteFields: { Sentence: '<b>字幕</b>', SentenceFurigana: '<b> 字幕[じまく]</b>' },
    updates,
    calls,
  });

  await service.updateLastAddedFromClipboard('字幕');

  assert.deepEqual(calls, []);
  assert.equal(updates[0]?.Sentence, '字幕');
  assert.equal('SentenceFurigana' in (updates[0] ?? {}), false);
});

test('clipboard update writes furigana to the configured sentenceFurigana field', async () => {
  const updates: Array<Record<string, string>> = [];
  const service = createClipboardUpdateService({
    fields: { sentenceFurigana: 'Furigana' },
    noteFields: { Sentence: '前の文。', Furigana: '前の文。', SentenceFurigana: '' },
    updates,
  });

  await service.updateLastAddedFromClipboard('字幕');

  assert.equal(updates[0]?.Furigana, ' 字幕[じまく]');
  assert.equal('SentenceFurigana' in (updates[0] ?? {}), false);
});

for (const [name, generateSentenceFurigana] of [
  ['finds no full parse', async () => null],
  [
    'throws',
    async () => {
      throw new Error('parser unavailable');
    },
  ],
] as const) {
  test(`clipboard update clears stale furigana when the parser ${name}`, async () => {
    const updates: Array<Record<string, string>> = [];
    const service = createClipboardUpdateService({
      noteFields: { Sentence: '前の文。', SentenceFurigana: ' 前[まえ]の 文[ぶん]。' },
      updates,
      generateSentenceFurigana,
    });

    await service.updateLastAddedFromClipboard('字幕');

    assert.equal(updates[0]?.Sentence, '字幕');
    assert.equal(updates[0]?.SentenceFurigana, '');
  });
}

test('clipboard update leaves a note without a furigana field alone', async () => {
  const updates: Array<Record<string, string>> = [];
  const calls: FuriganaCall[] = [];
  const service = createClipboardUpdateService({
    noteFields: { Sentence: '前の文。' },
    updates,
    calls,
  });

  await service.updateLastAddedFromClipboard('字幕');

  assert.deepEqual(calls, []);
  assert.deepEqual(updates, [{ Sentence: '字幕' }]);
});
