import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alignSentenceTranslation,
  buildSentenceTranslationGroups,
  joinSubtitleLineTexts,
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

test('mining one line of a split sentence keeps that line and resolves its translation', () => {
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
  });
  assert.equal(aligned?.translation, 'I put lots of vegetables in it.');
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

test('a sentence ends at its latest cue, not at the cue that starts last', () => {
  const primary = [line('長い台詞', 0, 10), line('短い', 2, 3)];
  const secondary = [line('The whole thing.', 0, 10)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 0,
    endTime: 10,
  });
  assert.equal(aligned?.text, '長い台詞 短い');
  assert.equal(aligned?.endTime, 10);
});

test('a line repeated by a simultaneous cue is joined once, a later repeat stays', () => {
  assert.equal(
    joinSubtitleLineTexts([
      line('First line\nSecond line', 0, 2),
      line('First line', 0, 2),
      line('First line', 5, 6),
    ]),
    'First line Second line First line',
  );
});

test('a long sign starting between two mined lines stays out of the sentence', () => {
  const primary = [line('一', 0, 1), line('看板', 0.1, 10), line('二', 1, 2)];
  const secondary = [line('One.', 0, 1), line('SIGN', 0.1, 10), line('Two.', 1, 2)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 0,
    endTime: 2,
  });
  assert.equal(aligned?.text, '一 二');
  assert.equal(aligned?.translation, 'One. Two.');
});

test('a dialogue line under a long sign takes its own translation on a tie', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('看板', 0, 10), line('一', 1, 2)],
    secondaryLines: [line('SIGN', 0, 10), line('One.', 1, 2)],
    startTime: 1,
    endTime: 2,
  });
  assert.equal(aligned?.text, '一');
  assert.equal(aligned?.translation, 'One.');
});

test('mined lines missing from the card sentence are left out', () => {
  const primary = [line('長い台詞です', 0, 4), line('看板', 1, 2)];
  const secondary = [line('A long line.', 0, 4), line('SIGN', 1, 2)];
  const withSentence = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 0,
    endTime: 4,
    sentenceText: '長い台詞です',
  });
  assert.equal(withSentence?.translation, 'A long line.');
  // Text that matches no line keeps every mined line.
  const unmatched = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 0,
    endTime: 4,
    sentenceText: 'something else',
  });
  assert.equal(unmatched?.translation, 'A long line. SIGN');
});

test('a slightly offset dialogue translation beats a sign covering the line', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('看板', 0, 10), line('一', 1, 2)],
    secondaryLines: [line('SIGN', 0, 10), line('One.', 0.9, 2.1)],
    startTime: 1,
    endTime: 2,
  });
  assert.equal(aligned?.translation, 'One.');
});

test('two speakers sharing an interval keep both translations', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('－行くぞ', 1, 3), line('－待って', 1, 3)],
    secondaryLines: [line("- Let's go.", 1, 3), line('- Wait.', 1, 3)],
    startTime: 1,
    endTime: 3,
  });
  assert.equal(aligned?.translationLines.length, 2);
});
