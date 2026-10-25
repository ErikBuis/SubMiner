import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCardSentenceTranslation } from './sentence-translation';

test('alignment never widens the clip past the maximum media duration', () => {
  // Card creation already clamped the 0–5s cue to the 3s maximum.
  const result = resolveCardSentenceTranslation({
    text: '長い台詞',
    startTime: 0,
    endTime: 3,
    tracks: {
      primary: [{ text: '長い台詞', startTime: 0, endTime: 5 }],
      secondary: [{ text: 'A long line.', startTime: 0, endTime: 5 }],
    },
    align: true,
    format: false,
    maxSentenceSeconds: 3,
  });
  assert.equal(result.widened, false);
  assert.deepEqual([result.startTime, result.endTime], [0, 3]);
  assert.equal(result.translation, 'A long line.');
});

test('aligned results carry the full-track translation of the lines around the clip', () => {
  const result = resolveCardSentenceTranslation({
    text: '今',
    startTime: 10,
    endTime: 14,
    tracks: {
      primary: [
        { text: '今', startTime: 10, endTime: 14 },
        { text: '次', startTime: 14, endTime: 16 },
      ],
      secondary: [
        { text: 'Now.', startTime: 10, endTime: 14 },
        { text: 'Next.', startTime: 14, endTime: 16 },
      ],
    },
    align: true,
    format: false,
    maxSentenceSeconds: 0,
  });
  assert.deepEqual(result.lineTranslations, [
    { startTime: 10, endTime: 14, lines: [{ text: 'Now.', startTime: 10, endTime: 14 }] },
    { startTime: 14, endTime: 16, lines: [{ text: 'Next.', startTime: 14, endTime: 16 }] },
  ]);
});
