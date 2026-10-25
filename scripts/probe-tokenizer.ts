import process from 'node:process';
import { createTokenizerDepsRuntime, tokenizeSubtitle } from '../src/core/services/tokenizer.js';
import { resolveYomitanExtensionPath } from '../src/core/services/yomitan-extension-paths.js';
import {
  getYomitanDictionaryInfo,
  importYomitanDictionaryFromZip,
  upsertYomitanDictionarySettings,
} from '../src/core/services/tokenizer/yomitan-parser-runtime.js';
import { MecabTokenizer } from '../src/mecab-tokenizer.js';

const logger = {
  info: (...a: unknown[]) => console.error('[info]', ...a),
  warn: (...a: unknown[]) => console.error('[warn]', ...a),
  error: (...a: unknown[]) => console.error('[error]', ...a),
  debug: () => undefined,
};

async function main() {
  const electron = await import('electron');
  electron.app.setPath('userData', process.env.PROBE_PROFILE ?? '/home/claude/sm-profile');
  await electron.app.whenReady();
  const extPath = resolveYomitanExtensionPath({ cwd: process.cwd() } as never) ?? `${process.cwd()}/dist/yomitan`;
  const extension = await electron.session.defaultSession.loadExtension(extPath, { allowFileAccess: true });
  const state: Record<string, unknown> = { win: null, ready: null, init: null };
  const known = new Set((process.env.PROBE_KNOWN ?? '').split(',').filter(Boolean));
  const mecab = new MecabTokenizer({});
  await mecab.checkAvailability();
  const deps = createTokenizerDepsRuntime({
    getYomitanExt: () => extension,
    getYomitanParserWindow: () => state.win as never,
    setYomitanParserWindow: (w) => { state.win = w; },
    getYomitanParserReadyPromise: () => state.ready as never,
    setYomitanParserReadyPromise: (p) => { state.ready = p; },
    getYomitanParserInitPromise: () => state.init as never,
    setYomitanParserInitPromise: (p) => { state.init = p; },
    isKnownWord: (text) => known.has(text),
    getKnownWordsEnabled: () => true,
    getNPlusOneEnabled: () => true,
    getKnownWordMatchMode: () => 'headword',
    getJlptLevel: () => null,
    getMecabTokenizer: () => mecab,
  });
  const rtDeps = deps as never;
  // Warm the parser window once so dictionary automation can run.
  await tokenizeSubtitle('テスト', deps);
  for (const zip of (process.env.PROBE_IMPORT ?? '').split(',').filter(Boolean)) {
    const ok = await importYomitanDictionaryFromZip(zip, { ...rtDeps, getYomitanExt: () => extension, getYomitanParserWindow: () => state.win, setYomitanParserWindow: (w: never) => { state.win = w; } } as never, logger);
    console.error('import', zip, ok);
  }
  const infos = await getYomitanDictionaryInfo({ getYomitanExt: () => extension, getYomitanParserWindow: () => state.win, setYomitanParserWindow: (w: never) => { state.win = w; }, getYomitanParserReadyPromise: () => state.ready, setYomitanParserReadyPromise: (p: never) => { state.ready = p; }, getYomitanParserInitPromise: () => state.init, setYomitanParserInitPromise: (p: never) => { state.init = p; } } as never, logger);
  console.error('dictionaries', infos.map((i) => i.title));
  if (process.env.PROBE_IMPORT) {
    for (const info of infos) {
      await upsertYomitanDictionarySettings(info.title, 'all', { getYomitanExt: () => extension, getYomitanParserWindow: () => state.win, setYomitanParserWindow: (w: never) => { state.win = w; }, getYomitanParserReadyPromise: () => state.ready, setYomitanParserReadyPromise: (p: never) => { state.ready = p; }, getYomitanParserInitPromise: () => state.init, setYomitanParserInitPromise: (p: never) => { state.init = p; } } as never, logger);
    }
  }
  const lines = process.env.PROBE_FILE ? require('node:fs').readFileSync(process.env.PROBE_FILE, 'utf8').split('\n').filter(Boolean) : process.argv.slice(process.argv.indexOf('--') + 1);
  const out: unknown[] = [];
  for (const line of lines) {
    const data = await tokenizeSubtitle(line, deps);
    const mecabTokens = await mecab.tokenize(line);
    const merged = await deps.tokenizeWithMecab(line);
    out.push({
      line,
      subminer: data.tokens?.map((t) => ({ s: t.surface, h: t.headword, r: t.reading, known: t.isKnown, n1: t.isNPlusOneTarget, pos: t.partOfSpeech, pos1: t.pos1 })),
      merged: merged?.map((t) => ({ s: t.surface, h: t.headword, pos1: t.pos1, pos2: t.pos2, a: t.startPos, b: t.endPos })),
      mecab: mecabTokens?.map((t) => ({ s: t.surface ?? (t as never as { word: string }).word, h: (t as never as { headword: string }).headword, pos: (t as never as { partOfSpeech: string }).partOfSpeech })),
    });
  }
  require('node:fs').writeFileSync(process.env.PROBE_OUT ?? '/tmp/probe-out.json', JSON.stringify(out, null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
