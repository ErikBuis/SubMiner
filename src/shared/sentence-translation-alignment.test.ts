import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alignSentenceTranslation,
  buildSentenceTranslationGroups,
  formatCardTranslation,
  type TimedSubtitleText,
} from './sentence-translation-alignment';

const line = (text: string, startTime: number, endTime: number): TimedSubtitleText => ({
  text,
  startTime,
  endTime,
});

test('a translation covering two primary lines groups them into one sentence', () => {
  const primary = [
    line('あの', 10, 11),
    line('今日は', 11.2, 12.5),
    line('いい天気ですね', 12.6, 14),
    line('次の文', 15, 16),
  ];
  const secondary = [line('Nice weather today, huh?', 11.1, 14.1), line('Next.', 15, 16)];
  const groups = buildSentenceTranslationGroups(primary, secondary);
  assert.equal(groups[0]!.secondary, null);
  assert.equal(groups[1], groups[2]);
  assert.deepEqual([groups[1]!.from, groups[1]!.to], [1, 2]);
  assert.equal(groups[3]!.secondary?.text, 'Next.');
});

test('mining one line of a split sentence widens to the whole sentence', () => {
  const primary = [line('今日は', 11.2, 12.5), line('いい天気ですね', 12.6, 14)];
  const secondary = [line('Nice weather today, huh?', 11.1, 14.1)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 12.6,
    endTime: 14,
    widenSentence: true,
  });
  assert.equal(aligned?.text, '今日は いい天気ですね');
  assert.equal(aligned?.startTime, 11.2);
  assert.equal(aligned?.endTime, 14);
  assert.equal(aligned?.translation, 'Nice weather today, huh?');
});

test('without widening only the mined line is kept but its translation still resolves', () => {
  const primary = [line('今日は', 11.2, 12.5), line('いい天気ですね', 12.6, 14)];
  const secondary = [line('Nice weather today, huh?', 11.1, 14.1)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 12.6,
    endTime: 14,
  });
  assert.equal(aligned?.text, 'いい天気ですね');
  assert.equal(aligned?.translation, 'Nice weather today, huh?');
});

test('an overlapping unrelated secondary line (background TV) is left out', () => {
  // Bocchi the Rock! ep. 1 around 00:37: the TV line overlaps the dialogue translation.
  const primary = [line('野菜もいっぱい入ってるよ', 36.4, 39.2)];
  const secondary = [
    line("There's a lot of vegetables,", 34.1, 37.0),
    line('I put lots of vegetables in it.', 36.3, 39.4),
  ];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 36.4,
    endTime: 39.2,
    widenSentence: true,
  });
  assert.equal(aligned?.translation, 'I put lots of vegetables in it.');
});

test('widening respects the maximum sentence length', () => {
  const primary = [line('一', 0, 10), line('二', 10, 20), line('三', 20, 30)];
  const secondary = [line('One two three.', 0, 30)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 10,
    endTime: 20,
    widenSentence: true,
    maxSentenceSeconds: 25,
  });
  assert.equal(aligned?.text, '二');
  assert.equal(aligned?.translation, 'One two three.');
});

test('a line no secondary event claims takes the event it overlaps most', () => {
  const primary = [line('長い台詞', 0, 10)];
  const secondary = [line('Short.', 0, 2), line('Longer bit.', 2, 6)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 0,
    endTime: 10,
  });
  assert.equal(aligned?.translation, 'Longer bit.');
});

test('alignment returns null when the mined range matches no primary line', () => {
  assert.equal(
    alignSentenceTranslation({
      primaryLines: [line('一', 0, 1)],
      secondaryLines: [],
      startTime: 5,
      endTime: 6,
    }),
    null,
  );
});

test('formatCardTranslation capitalizes and closes a comma-ended line', () => {
  assert.equal(formatCardTranslation('lost in that thought,'), 'Lost in that thought.');
  assert.equal(formatCardTranslation('"so what,"'), '"so what."');
  assert.equal(formatCardTranslation('<i>wait,</i>'), '<i>wait.</i>');
  assert.equal(formatCardTranslation('two\nlines'), 'Two lines');
  assert.equal(formatCardTranslation('Already fine!'), 'Already fine!');
  assert.equal(formatCardTranslation('   '), '');
});

test('a sentence ends at its latest cue, not at the cue that starts last', () => {
  const primary = [line('長い台詞', 0, 10), line('短い', 2, 3)];
  const secondary = [line('The whole thing.', 0, 10)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 2,
    endTime: 3,
    widenSentence: true,
  });
  assert.equal(aligned?.text, '長い台詞 短い');
  assert.equal(aligned?.endTime, 10);
});
