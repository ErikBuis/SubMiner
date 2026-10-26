import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanSentenceText, stripSpeakerLabels } from './subtitle-speaker-labels';

test('stripSpeakerLabels drops a label on its own line', () => {
  assert.equal(
    stripSpeakerLabels('（ひとり）\n部活も入らず 放課後は即帰宅'),
    '部活も入らず 放課後は即帰宅',
  );
});

test('stripSpeakerLabels drops a label in front of dialogue', () => {
  assert.equal(stripSpeakerLabels('（園児）せんせー、おはよう'), 'せんせー、おはよう');
  assert.equal(stripSpeakerLabels('(Hitori) Welcome home'), 'Welcome home');
  assert.equal(stripSpeakerLabels('（ひとり)　ただいま'), 'ただいま');
});

test('stripSpeakerLabels handles every line and stacked labels', () => {
  assert.equal(
    stripSpeakerLabels('（A）こんにちは\n（B）（笑）元気？\n普通の行'),
    'こんにちは\n元気？\n普通の行',
  );
});

test('stripSpeakerLabels keeps brackets that are not at the start of a line', () => {
  assert.equal(stripSpeakerLabels('それは（たぶん）本当だ'), 'それは（たぶん）本当だ');
  assert.equal(stripSpeakerLabels('「（ひとり）」と言った'), '「（ひとり）」と言った');
});

test('stripSpeakerLabels leaves text without labels untouched', () => {
  assert.equal(stripSpeakerLabels('部活も入らず\n放課後は即帰宅'), '部活も入らず\n放課後は即帰宅');
  assert.equal(stripSpeakerLabels('（）空'), '（）空');
});

test('stripSpeakerLabels never returns an empty sentence', () => {
  assert.equal(stripSpeakerLabels('（ひとり）'), '（ひとり）');
  assert.equal(stripSpeakerLabels('（拍手）\n（歓声）'), '（拍手）\n（歓声）');
});

test('cleanSentenceText respects the behavior flag', () => {
  assert.equal(cleanSentenceText('（ひとり）ただいま', undefined), 'ただいま');
  assert.equal(cleanSentenceText('（ひとり）ただいま', {}), 'ただいま');
  assert.equal(cleanSentenceText('（ひとり）ただいま', { stripSpeakerLabels: true }), 'ただいま');
  assert.equal(
    cleanSentenceText('（ひとり）ただいま', { stripSpeakerLabels: false }),
    '（ひとり）ただいま',
  );
});
