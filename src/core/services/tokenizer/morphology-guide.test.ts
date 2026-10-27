import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMecabLine } from '../../../mecab-tokenizer';
import type { Token } from '../../../types';
import {
  buildMorphologyGuide,
  createKuromojiMorphologyGuideRuntime,
  kuromojiTokenToMorpheme,
} from './morphology-guide';
import { requestYomitanScanTokens } from './yomitan-parser-runtime';
import {
  countTermsFindLookups,
  createBackendDeps,
  SUBMINER_TEST_CHARACTER_DICTIONARY,
  termEntry,
  termsFound,
} from './yomitan-scan-test-harness';

function morphemes(lines: string[]): Token[] {
  return lines.map((line) => parseMecabLine(line)).filter((token): token is Token => !!token);
}

// IPADIC analysis of このままで いいんだろうか, as MeCab and kuromoji print it.
const IIN_DAROU_KA = morphemes([
  'この\t連体詞,*,*,*,*,*,この,コノ,コノ',
  'まま\t名詞,非自立,副詞可能,*,*,*,まま,ママ,ママ',
  'で\t助詞,格助詞,一般,*,*,*,で,デ,デ',
  'いい\t形容詞,自立,*,*,形容詞・イイ,基本形,いい,イイ,イイ',
  'ん\t名詞,非自立,一般,*,*,*,ん,ン,ン',
  'だろ\t助動詞,*,*,*,特殊・ダ,未然形,だ,ダロ,ダロ',
  'う\t助動詞,*,*,*,不変化型,基本形,う,ウ,ウ',
  'か\t助詞,副助詞／並立助詞／終助詞,*,*,*,*,か,カ,カ',
]);

test('buildMorphologyGuide maps merged words and raw morpheme edges onto the line', () => {
  const guide = buildMorphologyGuide('このままで いいんだろうか', IIN_DAROU_KA);

  assert.deepEqual(
    guide?.words.map((word) => [word.start, word.end, word.pos1]),
    [
      [0, 2, '連体詞'],
      [2, 4, '名詞'],
      [4, 5, '助詞'],
      [6, 8, '形容詞'],
      [8, 9, '名詞'],
      [9, 12, '助動詞'],
      [12, 13, '助詞'],
    ],
  );
  // だろ|う stays split in the raw edges even though the merge joins it.
  assert.ok(guide?.morphemeEdges.includes(11));
});

test('buildMorphologyGuide returns null without morphemes', () => {
  assert.equal(buildMorphologyGuide('テスト', []), null);
});

test('kuromojiTokenToMorpheme matches what parseMecabLine reads from MeCab', () => {
  assert.deepEqual(
    kuromojiTokenToMorpheme({
      surface_form: 'いい',
      pos: '形容詞',
      pos_detail_1: '自立',
      pos_detail_2: '*',
      pos_detail_3: '*',
      conjugated_type: '形容詞・イイ',
      conjugated_form: '基本形',
      basic_form: 'いい',
      reading: 'イイ',
      pronunciation: 'イイ',
    }),
    parseMecabLine('いい\t形容詞,自立,*,*,形容詞・イイ,基本形,いい,イイ,イイ'),
  );
});

test('the bundled kuromoji dictionary loads and splits いいん into いい + ん', async () => {
  const runtime = createKuromojiMorphologyGuideRuntime();
  const guide = await runtime.buildGuide('いいんだろうか');

  assert.deepEqual(guide?.words.map((word) => [word.start, word.end]).slice(0, 2), [
    [0, 2],
    [2, 3],
  ]);
});

test('a dictionary that fails to load leaves the plain scan in charge', async () => {
  const warnings: string[] = [];
  const runtime = createKuromojiMorphologyGuideRuntime({
    loadKuromoji: () => {
      throw new Error('missing');
    },
    logWarn: (message) => warnings.push(message),
  });

  assert.equal(await runtime.buildGuide('テスト'), null);
  assert.equal(warnings.length, 1);
});

// A fake backend that answers termsFind with the longest listed surface the
// text starts with: [surface, headword, reading, wordClasses].
type FakeWord = [string, string, string, string[]];

function findLongestWord(words: FakeWord[], text: string) {
  const match = words
    .filter(([surface]) => text.startsWith(surface))
    .sort((left, right) => right[0].length - left[0].length)[0];
  if (!match) {
    return null;
  }
  const [surface, term, reading, wordClasses] = match;
  return termsFound(surface.length, {
    headwords: [
      {
        term,
        reading,
        wordClasses,
        sources: [{ originalText: surface, isPrimary: true, matchType: 'exact' }],
      },
    ],
    definitions: [{ dictionary: 'JMdict' }],
  });
}

function createWordDeps(words: FakeWord[]) {
  return createBackendDeps({
    dictionaries: ['JMdict'],
    termsFind: (text) => findLongestWord(words, text),
  });
}

async function scanSurfaces(
  text: string,
  words: FakeWord[],
  guideMorphemes: Token[] | null,
): Promise<string[]> {
  const result = await requestYomitanScanTokens(
    text,
    createWordDeps(words),
    { error: () => undefined },
    {
      morphologyGuide: guideMorphemes ? buildMorphologyGuide(text, guideMorphemes) : null,
    },
  );
  return (result ?? []).filter((token) => token.isUnparsedRun !== true).map((t) => t.surface);
}

const MESSAGE_WORDS: FakeWord[] = [
  ['の', 'の', 'の', []],
  ['のメッセ', 'のめす', 'のめす', ['v5']],
  ['メッセージ', 'メッセージ', 'めっせーじ', []],
  ['ー', 'ー', 'ー', []],
  ['ジか', '時価', 'じか', []],
  ['か', 'か', 'か', []],
];

const MESSAGE_MORPHEMES = morphemes([
  'の\t助詞,連体化,*,*,*,*,の,ノ,ノ',
  'メッセージ\t名詞,一般,*,*,*,*,メッセージ,メッセージ,メッセージ',
  'か\t助詞,副助詞／並立助詞／終助詞,*,*,*,*,か,カ,カ',
]);

test('the guide stops a longest match from cutting into the next word', async () => {
  assert.deepEqual(await scanSurfaces('のメッセージか', MESSAGE_WORDS, null), [
    'のメッセ',
    'ー',
    'ジか',
  ]);
  assert.deepEqual(await scanSurfaces('のメッセージか', MESSAGE_WORDS, MESSAGE_MORPHEMES), [
    'の',
    'メッセージ',
    'か',
  ]);
});

test('a guide lookup that finds nothing does not send the line to the unguided fallback', async () => {
  const lookups: string[] = [];
  const parsedTexts: string[] = [];
  const words = MESSAGE_WORDS.filter(([surface]) => surface !== 'メッセージ');
  const result = await requestYomitanScanTokens(
    'のメッセージか',
    createBackendDeps({
      dictionaries: ['JMdict'],
      lookups,
      // Probing at メ only reports a match it cannot use, at every window.
      termsFind: (text) => {
        if (text.startsWith('メ')) {
          return termsFound(
            text.length,
            termEntry('ミスマッチ', 'みすまっち', { originalText: 'ZZZ' }),
          );
        }
        return findLongestWord(words, text);
      },
      actions: {
        parseText: (params) => {
          parsedTexts.push((params as { text: string }).text);
          return [];
        },
      },
    }),
    { error: () => undefined },
    { morphologyGuide: buildMorphologyGuide('のメッセージか', MESSAGE_MORPHEMES) },
  );

  assert.ok(countTermsFindLookups(lookups, 'メ') > 0);
  assert.deepEqual(parsedTexts, []);
  assert.deepEqual(
    (result ?? []).map((token) => token.surface),
    ['のメッセ', 'ー', 'ジか'],
  );
});

test('the guide splits an adjective glued onto a dependent noun (いいん as 医院)', async () => {
  const words: FakeWord[] = [
    ['いい', 'いい', 'いい', ['adj-i']],
    ['いいん', '医院', 'いいん', []],
    ['ん', 'ん', 'ん', []],
    ['だろうか', 'だろうか', 'だろうか', []],
  ];
  const guideMorphemes = IIN_DAROU_KA.slice(3);

  assert.deepEqual(await scanSurfaces('いいんだろうか', words, guideMorphemes), [
    'いい',
    'ん',
    'だろうか',
  ]);
});

test('the guide keeps a dictionary verb that spans several morphemes', async () => {
  const words: FakeWord[] = [['読んでる', '読む', 'よむ', ['v5']]];
  const guideMorphemes = morphemes([
    '読ん\t動詞,自立,*,*,五段・マ行,連用タ接続,読む,ヨン,ヨン',
    'でる\t動詞,非自立,*,*,一段,基本形,でる,デル,デル',
  ]);

  assert.deepEqual(await scanSurfaces('読んでる', words, guideMorphemes), ['読んでる']);
});

test('a grammar word the match only partly covers is taken whole (でした, not 弟子+た)', async () => {
  const words: FakeWord[] = [
    ['ヤツ', 'ヤツ', 'やつ', []],
    ['ヤツデ', 'ヤツデ', 'やつで', []],
    ['でし', '弟子', 'でし', []],
    ['した', '下', 'した', []],
    ['た', 'た', 'た', []],
  ];
  const guideMorphemes = morphemes([
    'ヤツ\t名詞,一般,*,*,*,*,ヤツ,ヤツ,ヤツ',
    'でし\t助動詞,*,*,*,特殊・デス,連用形,です,デシ,デシ',
    'た\t助動詞,*,*,*,特殊・タ,基本形,た,タ,タ',
  ]);

  const result = await requestYomitanScanTokens(
    'ヤツでした',
    createWordDeps(words),
    { error: () => undefined },
    { morphologyGuide: buildMorphologyGuide('ヤツでした', guideMorphemes) },
  );
  assert.deepEqual(
    result?.map((token) => [token.surface, token.headword]),
    [
      ['ヤツ', 'ヤツ'],
      ['でした', 'です'],
    ],
  );
  // Classified as grammar even without MeCab enrichment downstream.
  assert.deepEqual(result?.[1]?.wordClasses, ['aux']);
});

test('a wave dash between kana is read as a stretched sound', async () => {
  const words: FakeWord[] = [
    ['か', 'か', 'か', []],
    ['かくれんぼ', '隠れん坊', 'かくれんぼ', []],
    ['くれん', 'くれる', 'くれる', ['v1']],
    ['ぼす', 'ボス', 'ぼす', []],
    ['する', 'する', 'する', ['vs-i']],
  ];
  const guideMorphemes = morphemes([
    'か\t助詞,副助詞／並立助詞／終助詞,*,*,*,*,か,カ,カ',
    '～\t記号,一般,*,*,*,*,～,～,～',
    'くれ\t動詞,自立,*,*,一段,未然形,くれる,クレ,クレ',
    'ん\t助動詞,*,*,*,不変化型,基本形,ん,ン,ン',
    'ぼ\t名詞,一般,*,*,*,*,ぼ,ボ,ボ',
    'する\t動詞,自立,*,*,サ変・スル,基本形,する,スル,スル',
  ]);

  assert.deepEqual(await scanSurfaces('か～くれんぼする', words, guideMorphemes), [
    'か～くれんぼ',
    'する',
  ]);
});

test('a character name stays whole when the guide widens the token before it', async () => {
  // タカ is a reserved name; the dictionary only matches でし, and the guide
  // would widen that to the grammar word でした, which cuts into the name.
  const result = await requestYomitanScanTokens(
    'でしタカ',
    createBackendDeps({
      dictionaries: ['JMdict', SUBMINER_TEST_CHARACTER_DICTIONARY],
      termsFind: (text) => {
        const words: Array<[string, string, string, string]> = [
          ['タカ', 'タカ', 'たか', SUBMINER_TEST_CHARACTER_DICTIONARY],
          ['でし', '弟子', 'でし', 'JMdict'],
          ['で', 'で', 'で', 'JMdict'],
        ];
        const match = words.find(([surface]) => text.startsWith(surface));
        if (!match) {
          return null;
        }
        const [surface, term, reading, dictionary] = match;
        return termsFound(
          surface.length,
          termEntry(term, reading, { originalText: surface, dictionary }),
        );
      },
    }),
    { error: () => undefined },
    {
      includeNameMatchMetadata: true,
      morphologyGuide: buildMorphologyGuide(
        'でしタカ',
        morphemes([
          'でした\t助動詞,*,*,*,特殊・デス,連用形,です,デシタ,デシタ',
          'カ\t名詞,一般,*,*,*,*,カ,カ,カ',
        ]),
      ),
    },
  );

  assert.deepEqual(
    result?.map((token) => token.surface),
    ['でし', 'タカ'],
  );
  assert.equal(result?.[1]?.isNameMatch, true);
});
