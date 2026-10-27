import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleFlightSubtitleTokenizer } from './subtitle-tokenization-single-flight';

function createControlledTokenizer() {
  const calls: string[] = [];
  const pending = new Map<string, Array<(value: string) => void>>();
  const rejecters = new Map<string, Array<(error: Error) => void>>();
  const tokenize = (text: string): Promise<string> => {
    calls.push(text);
    return new Promise<string>((resolve, reject) => {
      pending.set(text, [...(pending.get(text) ?? []), resolve]);
      rejecters.set(text, [...(rejecters.get(text) ?? []), reject]);
    });
  };
  const resolveAll = (text: string, value: string): void => {
    for (const resolve of pending.get(text) ?? []) resolve(value);
    pending.delete(text);
  };
  const rejectAll = (text: string, error: Error): void => {
    for (const reject of rejecters.get(text) ?? []) reject(error);
    rejecters.delete(text);
  };
  return { calls, tokenize, resolveAll, rejectAll };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('callers asking for the same line while it runs share one tokenization', async () => {
  const controlled = createControlledTokenizer();
  const tokenize = createSingleFlightSubtitleTokenizer({
    tokenize: controlled.tokenize,
    getCacheGeneration: () => 0,
  });

  const first = tokenize('猫が好きです。');
  const second = tokenize('猫が好きです。');
  await flush();
  assert.deepEqual(controlled.calls, ['猫が好きです。']);

  controlled.resolveAll('猫が好きです。', 'tokens');
  assert.equal(await first, 'tokens');
  assert.equal(await second, 'tokens');
});

test('different lines tokenize independently', async () => {
  const controlled = createControlledTokenizer();
  const tokenize = createSingleFlightSubtitleTokenizer({
    tokenize: controlled.tokenize,
    getCacheGeneration: () => 0,
  });

  const first = tokenize('一');
  const second = tokenize('二');
  await flush();
  assert.deepEqual(controlled.calls, ['一', '二']);
  controlled.resolveAll('一', 'a');
  controlled.resolveAll('二', 'b');
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
});

test('a finished tokenization is not reused by later callers', async () => {
  const controlled = createControlledTokenizer();
  const tokenize = createSingleFlightSubtitleTokenizer({
    tokenize: controlled.tokenize,
    getCacheGeneration: () => 0,
  });

  const first = tokenize('一');
  await flush();
  controlled.resolveAll('一', 'a');
  await first;

  const second = tokenize('一');
  await flush();
  assert.deepEqual(controlled.calls, ['一', '一']);
  controlled.resolveAll('一', 'b');
  assert.equal(await second, 'b');
});

test('a run started before a cache invalidation is not shared with later callers', async () => {
  const controlled = createControlledTokenizer();
  let generation = 0;
  const tokenize = createSingleFlightSubtitleTokenizer({
    tokenize: controlled.tokenize,
    getCacheGeneration: () => generation,
  });

  const stale = tokenize('一');
  generation = 1;
  const fresh = tokenize('一');
  const freshShared = tokenize('一');
  await flush();
  assert.deepEqual(controlled.calls, ['一', '一']);

  controlled.resolveAll('一', 'result');
  assert.deepEqual(await Promise.all([stale, fresh, freshShared]), ['result', 'result', 'result']);
});

test('a failed tokenization rejects every waiting caller and is not reused', async () => {
  const controlled = createControlledTokenizer();
  const tokenize = createSingleFlightSubtitleTokenizer({
    tokenize: controlled.tokenize,
    getCacheGeneration: () => 0,
  });

  const first = tokenize('一');
  const second = tokenize('一');
  await flush();
  controlled.rejectAll('一', new Error('yomitan unavailable'));
  await assert.rejects(first, /yomitan unavailable/);
  await assert.rejects(second, /yomitan unavailable/);

  const retry = tokenize('一');
  await flush();
  assert.deepEqual(controlled.calls, ['一', '一']);
  controlled.resolveAll('一', 'ok');
  assert.equal(await retry, 'ok');
});
