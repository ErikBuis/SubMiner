import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotateLineWithFurigana,
  parseBracketFurigana,
  stripBracketFurigana,
} from './furigana-markup';

test('parseBracketFurigana pairs each reading with the text before it', () => {
  assert.deepEqual(parseBracketFurigana('乗[の]り 遅[おく]れる'), [
    { text: '乗', reading: 'の' },
    { text: 'り' },
    { text: '遅', reading: 'おく' },
    { text: 'れる' },
  ]);
  assert.deepEqual(parseBracketFurigana(' 猫[ねこ]を 見[み]た。'), [
    { text: '猫', reading: 'ねこ' },
    { text: 'を' },
    { text: '見', reading: 'み' },
    { text: 'た。' },
  ]);
});

test('parseBracketFurigana leaves text without readings alone', () => {
  assert.deepEqual(parseBracketFurigana('plain text'), [{ text: 'plain text' }]);
  assert.deepEqual(parseBracketFurigana('[音楽]'), [{ text: '[音楽]' }]);
  assert.deepEqual(parseBracketFurigana(''), []);
});

test('stripBracketFurigana returns the visible sentence', () => {
  assert.equal(stripBracketFurigana(' 猫[ねこ]を 見[み]た。'), '猫を見た。');
});

test('annotateLineWithFurigana places readings over the line and keeps its spacing', () => {
  const segments = parseBracketFurigana(' 猫[ねこ]を 見[み]た。 犬[いぬ]も 居[い]た。');
  assert.deepEqual(annotateLineWithFurigana(segments, '猫を見た。'), [
    { text: '猫', reading: 'ねこ' },
    { text: 'を' },
    { text: '見', reading: 'み' },
    { text: 'た。' },
  ]);
  assert.deepEqual(annotateLineWithFurigana(segments, '犬も 居た。'), [
    { text: '犬', reading: 'いぬ' },
    { text: 'も ' },
    { text: '居', reading: 'い' },
    { text: 'た。' },
  ]);
  assert.deepEqual(
    annotateLineWithFurigana(parseBracketFurigana('でも 私[わたし] 話[はな]す'), 'でも 私 話す'),
    [
      { text: 'でも ' },
      { text: '私', reading: 'わたし' },
      { text: ' ' },
      { text: '話', reading: 'はな' },
      { text: 'す' },
    ],
  );
});

test('annotateLineWithFurigana splits plain text that crosses a line boundary', () => {
  const segments = parseBracketFurigana('猫[ねこ]がいる。\nあの 犬[いぬ]もいる。\nうん');
  assert.deepEqual(annotateLineWithFurigana(segments, '猫がいる。'), [
    { text: '猫', reading: 'ねこ' },
    { text: 'がいる。' },
  ]);
  assert.deepEqual(annotateLineWithFurigana(segments, 'あの犬もいる。'), [
    { text: 'あの' },
    { text: '犬', reading: 'いぬ' },
    { text: 'もいる。' },
  ]);
  assert.equal(annotateLineWithFurigana(segments, 'うん'), null);
});

test('annotateLineWithFurigana copes with a line that differs from the furigana text', () => {
  const segments = parseBracketFurigana('（ひとり）スマホに 届[とど]くのは');
  assert.deepEqual(annotateLineWithFurigana(segments, 'スマホに届くのは 親からの連絡だけ'), [
    { text: 'スマホに' },
    { text: '届', reading: 'とど' },
    { text: 'くのは 親からの連絡だけ' },
  ]);
});

test('annotateLineWithFurigana only anchors a reading where the text after it matches', () => {
  const segments = parseBracketFurigana('生[い]きる');
  assert.deepEqual(annotateLineWithFurigana(segments, '人生は生きる'), [
    { text: '人生は' },
    { text: '生', reading: 'い' },
    { text: 'きる' },
  ]);
  assert.equal(annotateLineWithFurigana(segments, '人生は続く'), null);
  assert.equal(annotateLineWithFurigana(segments, ''), null);
  assert.equal(annotateLineWithFurigana(parseBracketFurigana('plain'), 'plain'), null);
});
