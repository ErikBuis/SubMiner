import assert from 'node:assert/strict';
import test from 'node:test';
import { widenSentenceToTranslation } from './sentence-translation';

const tracks = {
  primary: [
    { text: '今日は', startTime: 11.2, endTime: 12.5 },
    { text: 'いい天気ですね', startTime: 12.6, endTime: 14 },
  ],
  secondary: [{ text: 'Nice weather today, huh?', startTime: 11.1, endTime: 14.1 }],
};

test('widenSentenceToTranslation grows to every line the translation covers', () => {
  assert.deepEqual(
    widenSentenceToTranslation({ startTime: 12.6, endTime: 14, tracks, maxSentenceSeconds: 0 }),
    { text: '今日は いい天気ですね', startTime: 11.2, endTime: 14 },
  );
});

test('widenSentenceToTranslation leaves a sentence that is already whole alone', () => {
  assert.equal(
    widenSentenceToTranslation({ startTime: 11.2, endTime: 14, tracks, maxSentenceSeconds: 0 }),
    null,
  );
});

test('widenSentenceToTranslation never takes the clip past the maximum duration', () => {
  // Card creation already clamped the 0–5s cue to the 3s maximum.
  assert.equal(
    widenSentenceToTranslation({
      startTime: 0,
      endTime: 3,
      tracks: {
        primary: [{ text: '長い台詞', startTime: 0, endTime: 5 }],
        secondary: [{ text: 'A long line.', startTime: 0, endTime: 5 }],
      },
      maxSentenceSeconds: 3,
    }),
    null,
  );
});
