type InFlightTokenization<T> = {
  generation: number;
  promise: Promise<T>;
};

/**
 * Shares one tokenization between callers that ask for the same line while it is still
 * running. At startup the live subtitle, the autoplay prime, and the prefetch priority
 * window all request the current line at once; each extra run competes for Yomitan and
 * slows the one the overlay is waiting on. A run started before a cache invalidation is
 * not shared with later callers, so they never receive a result from older settings.
 */
export function createSingleFlightSubtitleTokenizer<T>(deps: {
  tokenize: (text: string) => Promise<T>;
  getCacheGeneration: () => number;
}): (text: string) => Promise<T> {
  const inFlight = new Map<string, InFlightTokenization<T>>();

  return (text) => {
    const generation = deps.getCacheGeneration();
    const existing = inFlight.get(text);
    if (existing && existing.generation === generation) {
      return existing.promise;
    }

    const entry: InFlightTokenization<T> = {
      generation,
      promise: Promise.resolve()
        .then(() => deps.tokenize(text))
        .finally(() => {
          if (inFlight.get(text) === entry) {
            inFlight.delete(text);
          }
        }),
    };
    inFlight.set(text, entry);
    return entry.promise;
  };
}
