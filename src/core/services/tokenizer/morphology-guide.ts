// Morphological word boundaries that steer the greedy Yomitan scan. Yomitan
// segments a line by taking the longest dictionary match at each position,
// which happily reads のメッセ as のめす or ヤツでした as ヤツデ+下. A
// morphological analyzer (kuromoji, bundled with the IPA dictionary) knows
// where the words actually end, so the in-page scan uses its words to veto
// matches that cut into one (see applyMorphologyGuide in
// yomitan-scan-runtime-script.ts).
import path from 'node:path';
import { mergeTokens } from '../../../token-merger';
import type { Token } from '../../../types';
import { mapMecabPos1ToPartOfSpeech } from './part-of-speech';

/** One merged word as the analyzer sees it, in UTF-16 offsets of the line. */
export interface MorphologyGuideWord {
  start: number;
  end: number;
  pos1: string;
  pos2: string;
  headword: string;
  reading: string;
}

export interface MorphologyGuide {
  /** Words after merging inflections and auxiliaries (読んでる, でした). */
  words: MorphologyGuideWord[];
  /**
   * Edges of the raw morphemes, so a dictionary idiom that stops before an
   * auxiliary the merge glued on (頭に入れて + くれ) still ends on a boundary.
   */
  morphemeEdges: number[];
}

export function buildMorphologyGuide(text: string, morphemes: Token[]): MorphologyGuide | null {
  if (!text || morphemes.length === 0) {
    return null;
  }

  const morphemeEdges: number[] = [];
  let cursor = 0;
  for (const morpheme of morphemes) {
    const at = text.indexOf(morpheme.word, cursor);
    if (at < 0) {
      continue;
    }
    morphemeEdges.push(at, at + morpheme.word.length);
    cursor = at + morpheme.word.length;
  }

  const words = mergeTokens(morphemes, () => false, 'headword', false, text)
    .filter((token) => token.endPos > token.startPos)
    .map((token) => ({
      start: token.startPos,
      end: token.endPos,
      pos1: token.pos1 ?? '',
      pos2: token.pos2 ?? '',
      headword: token.headword,
      reading: token.reading,
    }));
  if (words.length === 0) {
    return null;
  }
  return { words, morphemeEdges };
}

// The subset of kuromoji's IPADIC token this module reads.
interface KuromojiToken {
  surface_form: string;
  pos: string;
  pos_detail_1: string;
  pos_detail_2: string;
  pos_detail_3: string;
  conjugated_type: string;
  conjugated_form: string;
  basic_form: string;
  reading?: string;
  pronunciation?: string;
}

interface KuromojiTokenizer {
  tokenize: (text: string) => KuromojiToken[];
}

interface KuromojiModule {
  builder: (options: { dicPath: string }) => {
    build: (callback: (error: Error | null, tokenizer: KuromojiTokenizer) => void) => void;
  };
}

function orEmpty(value: string | undefined): string {
  return value && value !== '*' ? value : '';
}

// Same shape parseMecabLine produces from MeCab's IPADIC output (including
// its '*' placeholders), so the merge rules shared with the MeCab path apply
// unchanged.
export function kuromojiTokenToMorpheme(token: KuromojiToken): Token {
  const pos1 = token.pos || '';
  return {
    word: token.surface_form,
    partOfSpeech: mapMecabPos1ToPartOfSpeech(pos1),
    pos1,
    pos2: token.pos_detail_1 || '',
    pos3: token.pos_detail_2 || '',
    pos4: token.pos_detail_3 || '',
    inflectionType: token.conjugated_type || '',
    inflectionForm: token.conjugated_form || '',
    headword: orEmpty(token.basic_form) || token.surface_form,
    katakanaReading: orEmpty(token.reading),
    pronunciation: orEmpty(token.pronunciation),
  };
}

export interface MorphologyGuideRuntime {
  /** Starts loading the dictionary (about 1-2 s) without waiting for it. */
  warmup: () => void;
  /** Resolves to null when the analyzer could not be loaded. */
  buildGuide: (text: string) => Promise<MorphologyGuide | null>;
}

export function createKuromojiMorphologyGuideRuntime(options?: {
  loadKuromoji?: () => KuromojiModule;
  resolveDictionaryPath?: () => string;
  logWarn?: (message: string) => void;
}): MorphologyGuideRuntime {
  const loadKuromoji =
    options?.loadKuromoji ?? (() => require('kuromoji') as unknown as KuromojiModule);
  const resolveDictionaryPath =
    options?.resolveDictionaryPath ??
    (() => path.join(path.dirname(require.resolve('kuromoji/package.json')), 'dict'));
  let tokenizerPromise: Promise<KuromojiTokenizer | null> | null = null;

  const ensureTokenizer = (): Promise<KuromojiTokenizer | null> => {
    if (!tokenizerPromise) {
      tokenizerPromise = new Promise((resolve) => {
        try {
          loadKuromoji()
            .builder({ dicPath: resolveDictionaryPath() })
            .build((error, tokenizer) => {
              if (error) {
                options?.logWarn?.(`Word splitting dictionary failed to load: ${error.message}`);
                resolve(null);
                return;
              }
              resolve(tokenizer);
            });
        } catch (error) {
          options?.logWarn?.(
            `Word splitting dictionary failed to load: ${(error as Error).message}`,
          );
          resolve(null);
        }
      });
    }
    return tokenizerPromise;
  };

  return {
    warmup: () => {
      void ensureTokenizer();
    },
    buildGuide: async (text) => {
      const tokenizer = await ensureTokenizer();
      if (!tokenizer || !text) {
        return null;
      }
      return buildMorphologyGuide(text, tokenizer.tokenize(text).map(kuromojiTokenToMorpheme));
    },
  };
}
