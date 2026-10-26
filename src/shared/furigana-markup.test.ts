import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseBracketFurigana,
  sliceFuriganaForLine,
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

test('sliceFuriganaForLine picks the segments that spell one line', () => {
  const segments = parseBracketFurigana(' 猫[ねこ]を 見[み]た。 犬[いぬ]も 居[い]た。');
  assert.deepEqual(sliceFuriganaForLine(segments, '猫を見た。'), [
    { text: '猫', reading: 'ねこ' },
    { text: 'を' },
    { text: '見', reading: 'み' },
    { text: 'た。' },
  ]);
  assert.deepEqual(sliceFuriganaForLine(segments, '犬も 居た。'), [
    { text: '犬', reading: 'いぬ' },
    { text: 'も' },
    { text: '居', reading: 'い' },
    { text: 'た。' },
  ]);
});

test('sliceFuriganaForLine splits plain text that crosses a line boundary', () => {
  const segments = parseBracketFurigana('猫[ねこ]がいる。\nあの 犬[いぬ]もいる。\nうん');
  assert.deepEqual(sliceFuriganaForLine(segments, '猫がいる。'), [
    { text: '猫', reading: 'ねこ' },
    { text: 'がいる。' },
  ]);
  assert.deepEqual(sliceFuriganaForLine(segments, 'あの犬もいる。'), [
    { text: 'あの' },
    { text: '犬', reading: 'いぬ' },
    { text: 'もいる。' },
  ]);
  assert.deepEqual(sliceFuriganaForLine(segments, 'うん'), [{ text: 'うん' }]);
});

test('sliceFuriganaForLine gives up when the line cuts through a segment or is absent', () => {
  const segments = parseBracketFurigana(' 猫[ねこ]を 見[み]た。');
  assert.equal(sliceFuriganaForLine(segments, '鳥が飛ぶ'), null);
  assert.equal(sliceFuriganaForLine(segments, ''), null);
  assert.equal(sliceFuriganaForLine(parseBracketFurigana('猫猫[ねこ]'), '猫'), null);
});
