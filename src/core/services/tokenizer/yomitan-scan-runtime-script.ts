// In-page Yomitan scan runtime: the scan walk that gets installed once per
// parser window as globalThis.__subminerYomitanScan, plus the tiny per-line
// call script. Kept separate from the host runtime module so the injected
// script text (which is data, not executed here) does not dominate that file;
// the helper bundle it embeds is composed in yomitan-scanning-helpers-script.ts
// from the yomitan-*-script.ts fragments.
import type { MorphologyGuide } from './morphology-guide';
import { YOMITAN_SCANNING_HELPERS } from './yomitan-scanning-helpers-script';

export { CHARACTER_DICTIONARY_TITLE_PREFIX } from './yomitan-scanning-helpers-script';

export type YomitanFrequencyMode = 'occurrence-based' | 'rank-based';

// Bump whenever the install script below changes so already-loaded parser
// windows re-install the new scan runtime instead of running the stale one.
export const YOMITAN_SCAN_RUNTIME_VERSION = 14;
export const YOMITAN_SCAN_RUNTIME_MISSING_SENTINEL = '__subminer-yomitan-scan-runtime-missing__';

export interface YomitanScanRequestParams {
  text: string;
  profileIndex: number;
  scanLength: number;
  includeNameMatchMetadata: boolean;
  greedyNameScanEnabled: boolean;
  currentCharacterDictionaryMediaId: number | null;
  dictionaryPriorityByName: Record<string, number>;
  dictionaryFrequencyModeByName: Partial<Record<string, YomitanFrequencyMode>>;
  cacheEpoch: number;
  /**
   * Key of the character-name candidate list installed for the current media,
   * or null to scan every Japanese position (see the pre-pass prefilter).
   */
  nameCandidateKey: string | null;
  /**
   * Word boundaries from a morphological analyzer, or null to keep the plain
   * greedy longest-match walk (see applyMorphologyGuide below).
   */
  morphologyGuide?: MorphologyGuide | null;
}

// Installed once per parser window (and re-installed after in-page reloads):
// keeps V8 from re-parsing the helper bundle on every subtitle line, and hosts
// the cross-line termsFind cache. Each subtitle line then only evaluates a tiny
// call into globalThis.__subminerYomitanScan.
export const YOMITAN_SCAN_RUNTIME_INSTALL_SCRIPT = String.raw`
  (() => {
    if (globalThis.__subminerYomitanScanVersion === ${YOMITAN_SCAN_RUNTIME_VERSION}) {
      return true;
    }
    const invoke = (action, params) =>
      new Promise((resolve, reject) => {
        (globalThis.__subminerDictionarySendMessage ?? chrome.runtime.sendMessage.bind(chrome.runtime))({ action, params }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response || typeof response !== "object") {
            reject(new Error("Invalid response from Yomitan backend"));
            return;
          }
          if (response.error) {
            reject(new Error(response.error.message || "Yomitan backend error"));
            return;
          }
          resolve(response.result);
        });
      });
    // Cross-line termsFind LRU keyed by profile + substring: subtitle lines
    // repeat particles and inflections constantly, so most lookups hit here.
    // Entries hold in-flight promises so concurrent identical lookups dedupe.
    const termsFindCache = new Map();
    // Two bounds. The key count keeps the map itself small; the accumulated
    // dictionary-entry count stands in for retained bytes, because a single
    // lookup over a common prefix can hold hundreds of entries with their full
    // glossaries and a key-count cap alone would not bound that.
    const TERMS_FIND_CACHE_LIMIT = 2000;
    const TERMS_FIND_CACHE_DICTIONARY_ENTRY_LIMIT = 20000;
    let termsFindCacheDictionaryEntries = 0;
    let termsFindCacheEpoch = -1;
    function dropCachedTermsFind(cacheKey, entry) {
      if (termsFindCache.get(cacheKey) !== entry) { return; }
      termsFindCache.delete(cacheKey);
      termsFindCacheDictionaryEntries -= entry.dictionaryEntryCount;
    }
    // Runs on insert and again once a lookup resolves: an entry is only worth
    // its estimated weight of 1 until then, so a single oversized response
    // would otherwise sit in the cache forever, over the limit and reused.
    function evictOverflowingTermsFindEntries() {
      while (
        termsFindCache.size > TERMS_FIND_CACHE_LIMIT ||
        termsFindCacheDictionaryEntries > TERMS_FIND_CACHE_DICTIONARY_ENTRY_LIMIT
      ) {
        const oldest = termsFindCache.entries().next().value;
        if (oldest === undefined) { break; }
        dropCachedTermsFind(oldest[0], oldest[1]);
      }
    }
    // Classification of a dictionary entry (which dictionaries it came from,
    // which media ids it mentions) depends only on the entry object, so it is
    // memoized for as long as that object lives. Entries are shared with the
    // termsFind cache above, which is what makes this worth keeping: the same
    // objects come back for every repeated lookup, on every line.
    const dictionaryEntryNamesCache = new WeakMap();
    const subMinerMediaIdsCache = new WeakMap();
    const EMPTY_MEDIA_ID_SET = new Set();
    // Only blind ladder steps are capped (see the retry loop): those are the
    // ones that would otherwise degrade into O(scanLength) lookups at a single
    // position. Steps the backend guides by reporting a shorter consumed length
    // stay uncapped, so a valid prefix term is still found on lines where
    // normalization eats a long tail.
    const MAX_BLIND_SHRINKING_WINDOW_RETRIES = 4;
    // Character-name candidate forms for the current media, installed
    // separately from the per-line scan call so the per-line script stays tiny.
    // Stored raw here; the normalized lookup index is built inside the scan,
    // where the kana-normalization helper is in scope, and reused by key.
    let rawNameCandidates = null;
    let nameCandidateIndex = null;
    globalThis.__subminerYomitanScanSetNameCandidates = (key, forms) => {
      if (!key || !Array.isArray(forms) || forms.length === 0) {
        rawNameCandidates = null;
        nameCandidateIndex = null;
        return false;
      }
      rawNameCandidates = { key, forms };
      nameCandidateIndex = null;
      return true;
    };
    globalThis.__subminerYomitanScanVersion = ${YOMITAN_SCAN_RUNTIME_VERSION};
    globalThis.__subminerYomitanScan = async (scanParams) => {
      const {
        text,
        profileIndex,
        scanLength,
        includeNameMatchMetadata,
        greedyNameScanEnabled,
        currentCharacterDictionaryMediaId,
        dictionaryPriorityByName,
        dictionaryFrequencyModeByName,
        cacheEpoch,
        nameCandidateKey,
        morphologyGuide
      } = scanParams;
      if (cacheEpoch !== termsFindCacheEpoch) {
        termsFindCache.clear();
        termsFindCacheDictionaryEntries = 0;
        termsFindCacheEpoch = cacheEpoch;
      }
${YOMITAN_SCANNING_HELPERS}
      const CAPTION_OPENING_BRACKETS = new Set(["(", "（", "[", "［", "{", "｛", "「", "『", "【", "〈", "《", "≪", "＜", "<"]);
      function shouldEmitUnparsedRunAsToken(runText) {
        if (!/[\p{L}\p{N}]/u.test(runText)) { return false; }
        const firstChar = Array.from(runText.trim())[0];
        return firstChar !== undefined && !CAPTION_OPENING_BRACKETS.has(firstChar);
      }
      function isLookupWorthyCodePoint(codePoint) {
        if (isCodePointJapanese(codePoint)) { return true; }
        return /[\p{L}\p{N}]/u.test(String.fromCodePoint(codePoint));
      }
      function isKanaOnlyRunText(runText) {
        const chars = Array.from(runText);
        return chars.length > 0 && chars.every((char) => isCodePointKana(char.codePointAt(0)));
      }
      const details = {matchType: "exact", deinflect: true};
      const tokens = [];
      async function termsFindAt(position, windowLength) {
        const substring = text.substring(position, position + windowLength);
        const cacheKey = profileIndex + "\u0000" + substring;
        const cached = termsFindCache.get(cacheKey);
        if (cached !== undefined) {
          termsFindCache.delete(cacheKey);
          termsFindCache.set(cacheKey, cached);
          return await cached.promise;
        }
        // An in-flight lookup counts as one entry until it resolves; the real
        // weight replaces that estimate once the result is known.
        const entry = { promise: null, dictionaryEntryCount: 1 };
        entry.promise = invoke("termsFind", { text: substring, details, optionsContext: { index: profileIndex } })
          .then((result) => {
            const resolvedCount =
              1 + (Array.isArray(result?.dictionaryEntries) ? result.dictionaryEntries.length : 0);
            const isCached = termsFindCache.get(cacheKey) === entry;
            if (isCached) {
              termsFindCacheDictionaryEntries += resolvedCount - entry.dictionaryEntryCount;
            }
            entry.dictionaryEntryCount = resolvedCount;
            // The real weight can push the cache over its budget, and a single
            // response can exceed it on its own, so re-check here.
            if (isCached) { evictOverflowingTermsFindEntries(); }
            return result;
          });
        termsFindCache.set(cacheKey, entry);
        termsFindCacheDictionaryEntries += entry.dictionaryEntryCount;
        evictOverflowingTermsFindEntries();
        try {
          return await entry.promise;
        } catch (error) {
          dropCachedTermsFind(cacheKey, entry);
          throw error;
        }
      }
      // Text the walk skips accumulates into unparsed runs, mirroring the
      // filler chunks the parseText segmentation used to provide: runs stay
      // hoverable (flagged isUnparsedRun) unless they are punctuation-only or
      // caption-style asides, and kana continuations of a longer headword
      // extend the previous token instead.
      function flushUnparsedRun(runStart, runEnd) {
        if (runStart === null || runEnd <= runStart) { return; }
        const runText = text.substring(runStart, runEnd);
        const previousToken = tokens[tokens.length - 1];
        if (
          previousToken &&
          previousToken.endPos === runStart &&
          isKanaOnlyRunText(runText) &&
          typeof previousToken.headword === "string" &&
          previousToken.headword.length > previousToken.surface.length &&
          previousToken.headword.startsWith(previousToken.surface + runText)
        ) {
          previousToken.surface += runText;
          // The run is kana-only, so its reading is itself: append it or the
          // reading stops covering the surface, which disables the known-word
          // reading fallback (isCompleteReadingForSurface) downstream.
          previousToken.reading += runText;
          // The run is kana-only, so its reading is itself: append it or the
          // reading stops covering the surface, which disables the known-word
          // reading fallback (isCompleteReadingForSurface) downstream.
          previousToken.endPos = runEnd;
          return;
        }
        if (!shouldEmitUnparsedRunAsToken(runText)) { return; }
        tokens.push({
          surface: runText,
          reading: "",
          headword: runText,
          startPos: runStart,
          endPos: runEnd,
          isUnparsedRun: true
        });
      }
      function buildScanToken(position, source, preferredHeadword) {
        const reading = typeof preferredHeadword.reading === "string" ? preferredHeadword.reading : "";
        const segments = distributeFuriganaInflected(preferredHeadword.term, reading, source);
        const tokenPayload = {
          surface: segments.map((segment) => segment.text).join("") || source,
          reading: segments.map(getSegmentReadingContribution).join(""),
          headword: preferredHeadword.term,
          headwordReading: reading || undefined,
          startPos: position,
          endPos: position + source.length,
          isNameMatch: includeNameMatchMetadata && preferredHeadword.isNameMatch === true,
          frequencyRank:
            typeof preferredHeadword.frequencyRank === "number" && Number.isFinite(preferredHeadword.frequencyRank)
              ? Math.max(1, Math.floor(preferredHeadword.frequencyRank))
              : undefined,
        };
        if (Array.isArray(preferredHeadword.wordClasses) && preferredHeadword.wordClasses.length > 0) {
          tokenPayload.wordClasses = preferredHeadword.wordClasses;
        }
        return tokenPayload;
      }
      // findTokenAt plus the shrinking-window ladder below it: Yomitan text
      // normalization can consume characters (whitespace, punctuation) beyond
      // the matched term, leaving no headword whose source equals the consumed
      // text. Retry with shorter windows so a valid prefix term (e.g. a
      // character name before a paren) still tokenizes instead of the position
      // being skipped.
      // Every window at or above the consumed length repeats the same result,
      // so the next informative window sits just below it. A lookup that
      // consumed its whole window reports nothing to aim at, and the step down
      // from it is a blind guess: only those are budgeted.
      // The window can run past the end of the line, so blindness is judged
      // against the text the lookup actually saw.
      // Set when a position stopped short of windows an uncapped ladder would
      // still have tried; the line then escalates to parseText at the end.
      let blindRetryBudgetExhausted = false;
      async function resolveTokenAt(position, windowLength) {
        let attempt = await findTokenAt(position, windowLength);
        const scannedLength = Math.min(windowLength, text.length - position);
        let retryLength = Math.min(attempt.matchedLength, scannedLength) - 1;
        let stepIsBlind = attempt.matchedLength >= scannedLength;
        let blindRetriesRemaining = MAX_BLIND_SHRINKING_WINDOW_RETRIES;
        while (!attempt.token && retryLength >= 1) {
          if (stepIsBlind) {
            if (blindRetriesRemaining <= 0) {
              blindRetryBudgetExhausted = true;
              break;
            }
            blindRetriesRemaining -= 1;
          }
          const retry = await findTokenAt(position, retryLength);
          if (retry.token) { return retry; }
          const guidedLength = retry.matchedLength - 1;
          stepIsBlind = guidedLength >= retryLength - 1;
          retryLength = Math.min(retryLength - 1, guidedLength);
        }
        return attempt;
      }
      async function findTokenAt(position, windowLength) {
        const codePoint = text.codePointAt(position);
        const character = String.fromCodePoint(codePoint);
        const result = await termsFindAt(position, windowLength);
        const dictionaryEntries = Array.isArray(result?.dictionaryEntries) ? result.dictionaryEntries : [];
        const originalTextLength = typeof result?.originalTextLength === "number" ? result.originalTextLength : 0;
        if (dictionaryEntries.length === 0 || originalTextLength <= 0 || (originalTextLength === character.length && !isCodePointJapanese(codePoint))) {
          return { token: null, matchedLength: 0 };
        }
        const source = text.substring(position, position + originalTextLength);
        const preferredHeadword = getPreferredHeadword(
          dictionaryEntries,
          source,
          dictionaryPriorityByName,
          dictionaryFrequencyModeByName
        );
        if (!preferredHeadword || typeof preferredHeadword.term !== "string") {
          return { token: null, matchedLength: originalTextLength };
        }
        return { token: buildScanToken(position, source, preferredHeadword), matchedLength: originalTextLength };
      }
      // Kana normalization folds halfwidth katakana one code point to one, so an
      // unvoiced halfwidth spelling prefix-matches a candidate form like any
      // other. What it cannot fold is a voiced pair: ｶ + ﾞ stays two characters
      // where the candidate form carries the single が, so the comparison fails
      // at that character. That break can sit anywhere inside the name, not
      // just at its first character (山ｶﾞｸ starts on a kanji), so the bypass is
      // keyed on the region a candidate could cover, not on how it starts.
      function isHalfwidthKanaVoicedMarkCodePoint(codePoint) {
        return codePoint === 0xff9e || codePoint === 0xff9f;
      }
      // Build (once per candidate list) a first-character bucket index of the
      // normalized name forms, so the pre-pass can reject a position with a
      // single map hit instead of a backend round trip.
      if (rawNameCandidates && nameCandidateIndex?.key !== rawNameCandidates.key) {
        const byFirstChar = new Map();
        for (const form of rawNameCandidates.forms) {
          const normalized = typeof form === "string" ? convertKatakanaToHiragana(form.trim()) : "";
          if (!normalized) { continue; }
          const bucket = byFirstChar.get(normalized[0]);
          if (bucket) { bucket.push(normalized); } else { byFirstChar.set(normalized[0], [normalized]); }
        }
        nameCandidateIndex = byFirstChar.size > 0 ? { key: rawNameCandidates.key, byFirstChar } : null;
      } else if (!rawNameCandidates) {
        nameCandidateIndex = null;
      }
      // Only meaningful when the installed list matches the media this scan is
      // for; otherwise fall back to scanning every position.
      const activeNameCandidateIndex =
        nameCandidateKey !== null && nameCandidateIndex?.key === nameCandidateKey
          ? nameCandidateIndex
          : null;
      const normalizedText = activeNameCandidateIndex ? convertKatakanaToHiragana(text) : "";
      // Yomitan collapses emphatic sequences before matching (すっっごーーい →
      // すごい), so a stretched name still resolves to its entry. Skipping these
      // characters keeps such spellings candidates; the filter only ever grows
      // the probe set, so a false positive costs one lookup, never a name.
      const EMPHATIC_SKIP_CHARS = new Set(["ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "っ", "ゃ", "ゅ", "ょ", "ー"]);
      function matchesCandidateFormAt(form, position) {
        let textIndex = position;
        for (let formIndex = 0; formIndex < form.length; formIndex += 1) {
          while (
            textIndex < normalizedText.length &&
            normalizedText[textIndex] !== form[formIndex] &&
            EMPHATIC_SKIP_CHARS.has(normalizedText[textIndex])
          ) {
            textIndex += 1;
          }
          if (normalizedText[textIndex] !== form[formIndex]) { return false; }
          textIndex += 1;
        }
        return true;
      }
      // Where the folding gives up, listed once per line. Matching may skip any
      // number of emphatic characters on its way through a form (山ーーーーーーｶﾞｸ),
      // so there is no shorter honest bound than the window a name lookup
      // covers: scanLength. The list is almost always empty, which is what
      // keeps the check below free on ordinary lines.
      const halfwidthVoicedMarkPositions = [];
      if (activeNameCandidateIndex) {
        for (let index = 0; index < text.length; index += 1) {
          if (isHalfwidthKanaVoicedMarkCodePoint(text.charCodeAt(index))) {
            halfwidthVoicedMarkPositions.push(index);
          }
        }
      }
      function hasHalfwidthVoicedMarkInScanWindow(position) {
        const end = position + scanLength;
        for (const markPosition of halfwidthVoicedMarkPositions) {
          if (markPosition >= position && markPosition < end) { return true; }
        }
        return false;
      }
      // A name written ｶﾞ... folds to か + ﾞ, so its first character never leads
      // to the が bucket the candidate form is filed under. Nothing else can
      // find it, so such a position is always worth a probe.
      function startsHalfwidthVoicedPair(position, codePoint) {
        if (codePoint < 0xff66 || codePoint > 0xff9d) { return false; }
        return isHalfwidthKanaVoicedMarkCodePoint(text.charCodeAt(position + 1));
      }
      function couldNameStartAt(position, codePoint) {
        // Nothing starts with a combining voiced mark, whether or not the
        // prefilter is active.
        if (isHalfwidthKanaVoicedMarkCodePoint(codePoint)) { return false; }
        if (!activeNameCandidateIndex) { return true; }
        const bucket = activeNameCandidateIndex.byFirstChar.get(normalizedText[position]);
        if (!bucket) {
          // No candidate begins with this character, and the window search
          // below would only ever say yes to positions like this one, so an
          // unrelated ｶﾞ elsewhere in the line must not drag them in.
          return startsHalfwidthVoicedPair(position, codePoint);
        }
        for (const form of bucket) {
          if (matchesCandidateFormAt(form, position)) { return true; }
        }
        // A candidate does start here but did not match: an unfoldable voiced
        // pair anywhere in the window is a reason the comparison could not see
        // it (山ｶﾞｸ, 山ーーーーーーｶﾞｸ), so probe rather than drop the name.
        return hasHalfwidthVoicedMarkInScanWindow(position);
      }
      // Greedy name pre-pass: character-name matches claim their spans before
      // the left-to-right walk, so a longer generic match starting earlier
      // (e.g. とヨー → 渡洋) cannot swallow the start of a name (ヨータ).
      const nameTokens = [];
      if (greedyNameScanEnabled) {
        let namePos = 0;
        while (namePos < text.length) {
          const codePoint = text.codePointAt(namePos);
          if (!isCodePointJapanese(codePoint) || !couldNameStartAt(namePos, codePoint)) {
            namePos += String.fromCodePoint(codePoint).length;
            continue;
          }
          const result = await termsFindAt(namePos, scanLength);
          const dictionaryEntries = Array.isArray(result?.dictionaryEntries) ? result.dictionaryEntries : [];
          const textWindow = text.substring(namePos, namePos + scanLength);
          const nameMatch = findLongestNameMatch(dictionaryEntries, textWindow);
          // A name only claims its span when no strictly longer generic word
          // starts at the same position (a character named 空 must not split
          // 空気). Ties go to the name. Generic matches that start earlier and
          // overlap the name are still blocked by the reservation.
          if (
            !nameMatch ||
            findLongestGenericMatchLength(dictionaryEntries, textWindow) > nameMatch.sourceLength
          ) {
            namePos += String.fromCodePoint(codePoint).length;
            continue;
          }
          const source = text.substring(namePos, namePos + nameMatch.sourceLength);
          nameTokens.push(buildScanToken(namePos, source, {
            term: nameMatch.headword.term,
            reading: nameMatch.headword.reading,
            wordClasses: normalizeWordClasses(nameMatch.headword),
            isNameMatch: true,
            frequencyRank: getBestFrequencyRank(
              nameMatch.dictionaryEntry,
              nameMatch.headwordIndex,
              dictionaryPriorityByName,
              dictionaryFrequencyModeByName
            )
          }));
          namePos += nameMatch.sourceLength;
        }
      }
      // First reserved name span that a match ending at endPos would leave
      // half-consumed. Spans the match covers entirely are not returned: those
      // lose to the longer word instead of splitting it.
      function findSplitNameToken(startIndex, endPos) {
        for (let index = startIndex; index < nameTokens.length; index += 1) {
          const nameToken = nameTokens[index];
          if (nameToken.startPos >= endPos) { return null; }
          if (nameToken.endPos > endPos) { return nameToken; }
        }
        return null;
      }
      // Morphology guide. The walk below takes the longest dictionary match at
      // each position, which reads のメッセージ as のめす+ー+ジ and ヤツでした as
      // ヤツデ+下. When the host passes the line's words from a morphological
      // analyzer, a match that cuts into one of those words is retried with
      // the window capped at the last word boundary inside it.
      const guideWords = morphologyGuide && Array.isArray(morphologyGuide.words) ? morphologyGuide.words : null;
      const guideBoundaries = new Set();
      if (guideWords) {
        for (const word of guideWords) {
          guideBoundaries.add(word.start);
          guideBoundaries.add(word.end);
        }
        for (const edge of morphologyGuide.morphemeEdges || []) { guideBoundaries.add(edge); }
      }
      function lastGuideBoundaryInside(start, end) {
        let best = -1;
        for (const boundary of guideBoundaries) {
          if (boundary > start && boundary < end && boundary > best) { best = boundary; }
        }
        return best;
      }
      function isGrammarGuideWord(word) {
        return word.pos1 === "助動詞" || word.pos1 === "助詞";
      }
      function guideWordContaining(offset) {
        return guideWords.find((word) => word.start <= offset && word.end > offset);
      }
      // A particle right before the cut (の in のメッセ) or a grammar word right
      // after it (でし in ヤツデ). Connective て/で stay out: they belong to the
      // verb form before them (悩んで+いた).
      function isSwallowedGrammarCut(cut) {
        const before = guideWordContaining(cut - 1);
        const after = guideWordContaining(cut);
        const isGrammar = (word) => word && isGrammarGuideWord(word) && word.pos2 !== "接続助詞";
        return isGrammar(before) || isGrammar(after);
      }
      function hasWordClassPrefix(wordClasses, prefix) {
        return Array.isArray(wordClasses) &&
          wordClasses.some((wordClass) => typeof wordClass === "string" && wordClass.startsWith(prefix));
      }
      // A verb or adjective followed by the nominalizer ん/の (いい+ん, 来る+の)
      // that the dictionary reads as one unrelated noun (いいん as 医院).
      // Other dependent nouns stay glued: 言うとおり is a real expression.
      function gluesInflectableOntoDependentNoun(position, end, wordClasses) {
        const covered = guideWords.filter((word) => word.start < end && word.end > position);
        const first = covered[0];
        const second = covered[1];
        if (!first || !second || first.start !== position) { return false; }
        if (second.pos1 !== "名詞" || second.pos2 !== "非自立") { return false; }
        const nominalizer = text.substring(second.start, second.end);
        if (nominalizer !== "ん" && nominalizer !== "の") { return false; }
        if (first.pos1 === "動詞") { return !hasWordClassPrefix(wordClasses, "v"); }
        if (first.pos1 === "形容詞") { return !hasWordClassPrefix(wordClasses, "adj"); }
        return false;
      }
      function grammarWordToken(word) {
        const surface = text.substring(word.start, word.end);
        return {
          token: {
            surface,
            reading: word.reading || "",
            headword: word.headword || surface,
            startPos: word.start,
            endPos: word.end,
            isNameMatch: false,
            // Keeps the analyzer's class when MeCab is not there to enrich it.
            wordClasses: [word.pos1 === "助詞" ? "prt" : "aux"]
          },
          matchedLength: word.end - word.start
        };
      }
      // A lookup the guide may throw away: one that gave up only there must not
      // escalate the whole line to the unguided parseText fallback.
      async function probeTokenAt(position, windowLength) {
        const exhaustedBefore = blindRetryBudgetExhausted;
        const probe = await resolveTokenAt(position, windowLength);
        if (!probe.token) { blindRetryBudgetExhausted = exhaustedBefore; }
        return probe;
      }
      async function applyMorphologyGuide(position, attempt) {
        if (!guideWords || !attempt.token || attempt.token.isNameMatch) { return attempt; }
        let current = attempt;
        // Each retry shrinks the window, so a handful of rounds always settles.
        for (let round = 0; round < 4 && current.token; round += 1) {
          const end = position + current.matchedLength;
          // A grammar word the match only partly covers (でし read as 弟子
          // inside でした) is taken as the analyzer's word.
          const wordHere = guideWords.find((word) => word.start === position);
          if (wordHere && end < wordHere.end && isGrammarGuideWord(wordHere)) {
            return grammarWordToken(wordHere);
          }
          let cap = -1;
          if (!guideBoundaries.has(end)) {
            // Only cut when the dictionary agrees on the word the match cut
            // into (its own longest match there ends on a boundary at or past
            // this one) and the cut looks like a real misreading: the match
            // swallowed a particle or the start of a grammar word (の+メッセ,
            // ヤツ+デ), or the word it cut into is at least as long as the
            // match itself. The analyzer misreads kana spellings often enough
            // (ひとり+ぼっ+ちの) that its boundary alone is not a reason to
            // split a longer dictionary word.
            const nextStart = lastGuideBoundaryInside(position, end);
            if (nextStart > position) {
              const next = await probeTokenAt(nextStart, scanLength);
              const nextEnd = nextStart + next.matchedLength;
              if (
                next.token &&
                nextEnd >= end &&
                guideBoundaries.has(nextEnd) &&
                (isSwallowedGrammarCut(nextStart) || next.matchedLength >= current.matchedLength)
              ) {
                cap = nextStart;
              }
            }
          } else if (gluesInflectableOntoDependentNoun(position, end, current.token.wordClasses)) {
            cap = guideWords.find((word) => word.start === position).end;
          }
          if (cap <= position) { break; }
          const retry = await probeTokenAt(position, cap - position);
          if (!retry.token) { break; }
          current = retry;
        }
        return current;
      }
      // A wave dash between kana stretches a sound (か～くれんぼ, バイバ～イ).
      // Yomitan only collapses repeated ー and small kana, so look the word up
      // with those dashes removed and map the match back onto the line.
      const WAVE_DASHES = new Set(["～", "〜"]);
      async function applyWaveDashElongation(position, attempt) {
        if (!guideWords) { return attempt; }
        const chars = Array.from(text.substring(position, position + scanLength + 4));
        let squeezed = "";
        const lineLengthAfter = [0];
        let lineLength = 0;
        let removedDash = false;
        for (let index = 0; index < chars.length; index += 1) {
          const char = chars[index];
          lineLength += char.length;
          const isStretch =
            WAVE_DASHES.has(char) &&
            index > 0 &&
            index + 1 < chars.length &&
            isCodePointKana(chars[index - 1].codePointAt(0)) &&
            isCodePointKana(chars[index + 1].codePointAt(0));
          if (isStretch) {
            removedDash = true;
            continue;
          }
          squeezed += char;
          lineLengthAfter[squeezed.length] = lineLength;
        }
        if (!removedDash) { return attempt; }
        const result = await invoke("termsFind", { text: squeezed, details, optionsContext: { index: profileIndex } });
        const dictionaryEntries = Array.isArray(result?.dictionaryEntries) ? result.dictionaryEntries : [];
        const squeezedLength = typeof result?.originalTextLength === "number" ? result.originalTextLength : 0;
        const matchedLength = squeezedLength > 0 ? lineLengthAfter[squeezedLength] : 0;
        if (!matchedLength || matchedLength <= (attempt.token ? attempt.matchedLength : 0)) { return attempt; }
        const source = squeezed.substring(0, squeezedLength);
        const preferredHeadword = getPreferredHeadword(
          dictionaryEntries,
          source,
          dictionaryPriorityByName,
          dictionaryFrequencyModeByName
        );
        if (!preferredHeadword || typeof preferredHeadword.term !== "string") { return attempt; }
        const token = buildScanToken(position, source, preferredHeadword);
        token.surface = text.substring(position, position + matchedLength);
        token.endPos = position + matchedLength;
        return { token, matchedLength };
      }
      let i = 0;
      let nameIndex = 0;
      let unparsedRunStart = null;
      while (i < text.length) {
        while (nameIndex < nameTokens.length && nameTokens[nameIndex].startPos < i) { nameIndex += 1; }
        const nextNameToken = nameIndex < nameTokens.length ? nameTokens[nameIndex] : null;
        if (nextNameToken && nextNameToken.startPos === i) {
          flushUnparsedRun(unparsedRunStart, i);
          unparsedRunStart = null;
          tokens.push(nextNameToken);
          i = nextNameToken.endPos;
          nameIndex += 1;
          continue;
        }
        const codePoint = text.codePointAt(i);
        // Punctuation and whitespace can never start a token: skip the backend
        // round trip entirely. Latin letters and digits stay lookup-worthy
        // (terms like Tシャツ start on an ASCII letter).
        if (!isLookupWorthyCodePoint(codePoint)) {
          if (unparsedRunStart === null) { unparsedRunStart = i; }
          i += String.fromCodePoint(codePoint).length;
          continue;
        }
        // A reservation only outranks generic matches that would cut into it.
        // Look the position up unrestricted first: a generic word that starts
        // earlier and covers the whole name span (写真 over a character named
        // 真) is the better reading, so the reservation yields rather than
        // splitting the word. Only a match that ends inside a name span gets
        // re-run against a window capped at that span.
        // The guide and the wave-dash reading can move the token's end, so
        // they run before the name check sees where it ends.
        let attempt = await resolveTokenAt(i, scanLength);
        attempt = await applyWaveDashElongation(i, attempt);
        attempt = await applyMorphologyGuide(i, attempt);
        if (attempt.token) {
          const splitNameToken = findSplitNameToken(nameIndex, attempt.token.endPos);
          if (splitNameToken) {
            attempt = await resolveTokenAt(i, splitNameToken.startPos - i);
          }
        }
        if (attempt.token) {
          flushUnparsedRun(unparsedRunStart, i);
          unparsedRunStart = null;
          tokens.push(attempt.token);
          i += attempt.matchedLength;
          continue;
        }
        if (unparsedRunStart === null) { unparsedRunStart = i; }
        i += String.fromCodePoint(text.codePointAt(i)).length;
      }
      flushUnparsedRun(unparsedRunStart, text.length);
      if (blindRetryBudgetExhausted) {
        // A position gave up with shorter windows still worth trying. The walk
        // is the only tokenizer now, so stopping there would leave a real term
        // as an unparsed run; report it so the host can spend one parseText on
        // the line instead of letting the ladder run to O(scanLength) lookups.
        return { tokens, retryBudgetExhausted: true };
      }
      return tokens;
    };
    return true;
  })();
`;

// Installs (or clears) the character-name candidate forms for the current
// media. Runs only when the list changes, not per line. Passing null restores
// the exhaustive every-position pre-pass.
export function buildYomitanScanNameCandidatesScript(
  nameCandidates: { key: string; forms: string[] } | null,
): string {
  if (!nameCandidates) {
    return `
    (() => {
      if (typeof globalThis.__subminerYomitanScanSetNameCandidates !== "function") {
        return false;
      }
      return globalThis.__subminerYomitanScanSetNameCandidates(null, null);
    })();
  `;
  }

  return `
    (() => {
      if (typeof globalThis.__subminerYomitanScanSetNameCandidates !== "function") {
        return false;
      }
      return globalThis.__subminerYomitanScanSetNameCandidates(
        ${JSON.stringify(nameCandidates.key)},
        ${JSON.stringify(nameCandidates.forms)}
      );
    })();
  `;
}

export function buildYomitanScanCallScript(params: YomitanScanRequestParams): string {
  return `
    (async () => {
      if (typeof globalThis.__subminerYomitanScan !== "function") {
        return ${JSON.stringify(YOMITAN_SCAN_RUNTIME_MISSING_SENTINEL)};
      }
      return await globalThis.__subminerYomitanScan(${JSON.stringify(params)});
    })();
  `;
}
