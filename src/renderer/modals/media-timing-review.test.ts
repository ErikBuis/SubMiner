import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMediaTimingReviewTranslation,
  buildMediaTimingLineSelection,
  buildMediaTimingWaveformPath,
  constrainMediaTimingSelection,
  createMediaTimingPreviewRequestGuard,
  formatMediaTimingTimestamp,
  mediaTimingTimeFromPointer,
  slideMediaTimingSelection,
  trimMediaTimingSelectionEnd,
} from './media-timing-review';

test('waveform path mirrors normalized peaks around its center line', () => {
  const path = buildMediaTimingWaveformPath([0, 0.5, 1]);

  assert.match(path, /^M 0\.00 50\.00 L 500\.00 28\.00 L 1000\.00 6\.00/);
  assert.match(path, /1000\.00 94\.00 L 500\.00 72\.00 L 0\.00 50\.00 Z$/);
  assert.equal(buildMediaTimingWaveformPath([1]), '');
});

test('formatMediaTimingTimestamp renders stable review readouts', () => {
  assert.equal(formatMediaTimingTimestamp(65.4321), '01:05.432');
  assert.equal(formatMediaTimingTimestamp(65.4321, false), '01:05');
  assert.equal(formatMediaTimingTimestamp(-1), '00:00.000');
  assert.equal(formatMediaTimingTimestamp(119.9999), '02:00.000');
  assert.equal(formatMediaTimingTimestamp(119.6, false), '02:00');
});

test('selection constraints preserve the handle that did not move', () => {
  assert.deepEqual(
    constrainMediaTimingSelection({
      nextStart: 3,
      nextEnd: 2,
      currentStart: 1,
      timelineStart: 0,
      timelineEnd: 10,
      mediaEnd: 10,
      maxMediaDuration: 30,
    }),
    { start: 1.9, end: 2 },
  );
  assert.deepEqual(
    constrainMediaTimingSelection({
      nextStart: 1,
      nextEnd: 0.5,
      currentStart: 1,
      timelineStart: 0,
      timelineEnd: 10,
      mediaEnd: 10,
      maxMediaDuration: 30,
    }),
    { start: 1, end: 1.1 },
  );
});

test('pointer positions map onto the visible timeline and clamp past its edges', () => {
  const track = { trackLeft: 100, trackWidth: 400, timelineStart: 10, timelineEnd: 20 };

  assert.equal(mediaTimingTimeFromPointer({ clientX: 100, ...track }), 10);
  assert.equal(mediaTimingTimeFromPointer({ clientX: 300, ...track }), 15);
  assert.equal(mediaTimingTimeFromPointer({ clientX: -40, ...track }), 10);
  assert.equal(mediaTimingTimeFromPointer({ clientX: 900, ...track }), 20);
  assert.equal(mediaTimingTimeFromPointer({ ...track, clientX: 300, trackWidth: 0 }), 10);
});

test('sliding keeps the clip length and stops at the timeline and media bounds', () => {
  const timeline = { span: 2, timelineStart: 4, timelineEnd: 12, mediaEnd: 10 };

  assert.deepEqual(slideMediaTimingSelection({ nextStart: 6, ...timeline }), { start: 6, end: 8 });
  assert.deepEqual(slideMediaTimingSelection({ nextStart: 1, ...timeline }), { start: 4, end: 6 });
  assert.deepEqual(slideMediaTimingSelection({ nextStart: 99, ...timeline }), {
    start: 8,
    end: 10,
  });
});

test('line selection combines adjacent lines around the mined one and tracks their range', () => {
  const base = {
    previousLines: [
      { text: '一行目', startTime: 0, endTime: 2 },
      { text: '二行目', startTime: 2.5, endTime: 4 },
    ],
    nextLines: [
      { text: '四行目', startTime: 7.5, endTime: 9 },
      { text: '五行目', startTime: 9.5, endTime: 11 },
    ],
    text: '採掘行',
    originalStartTime: 5,
    originalEndTime: 7,
  };

  const none = buildMediaTimingLineSelection({ ...base, previousCount: 0, nextCount: 0 });
  assert.deepEqual(none.lineTexts, ['採掘行']);
  assert.equal(none.currentLineIndex, 0);
  assert.equal(none.rangeStart, 5);
  assert.equal(none.rangeEnd, 7);

  const expanded = buildMediaTimingLineSelection({ ...base, previousCount: 1, nextCount: 2 });
  assert.deepEqual(expanded.lineTexts, ['二行目', '採掘行', '四行目', '五行目']);
  assert.equal(expanded.currentLineIndex, 1);
  assert.equal(expanded.sentence, '二行目 採掘行 四行目 五行目');
  assert.equal(expanded.rangeStart, 2.5);
  assert.equal(expanded.rangeEnd, 11);
});

test('line selection ends at the latest added cue, not the last one', () => {
  const selection = buildMediaTimingLineSelection({
    previousLines: [],
    nextLines: [
      { text: '長い', startTime: 2, endTime: 10 },
      { text: '短い', startTime: 3, endTime: 4 },
    ],
    text: '今',
    originalStartTime: 0,
    originalEndTime: 1,
    previousCount: 0,
    nextCount: 2,
  });
  assert.equal(selection.rangeEnd, 10);
});

test('preview request guard blocks overlap and invalidates stale responses', () => {
  const guard = createMediaTimingPreviewRequestGuard();
  const first = guard.begin();

  assert.equal(typeof first, 'number');
  assert.equal(guard.begin(), null);
  assert.equal(guard.isCurrent(first!), true);

  guard.invalidate();
  assert.equal(guard.isCurrent(first!), false);
  assert.equal(guard.isInFlight(), false);

  const second = guard.begin();
  assert.equal(typeof second, 'number');
  guard.finish(first!);
  assert.equal(guard.isCurrent(second!), true);
  guard.finish(second!);
  assert.equal(guard.isInFlight(), false);
});

test('trailing silence trim follows the last speech slice and keeps cut-off or silent lines', () => {
  // 10 slices over a 10 s timeline: one slice per second, speech in seconds 2-4 only.
  const peaks = [0, 0, 0.9, 0.8, 0.7, 0.1, 0.2, 0, 0, 0];
  const base = { peaks, timelineStart: 0, timelineEnd: 10, lineStart: 2, lineEnd: 8 };

  const trimmed = trimMediaTimingSelectionEnd({ ...base, selectionEnd: 8, endPadSeconds: 0 });
  assert.ok(trimmed !== null && Math.abs(trimmed - 5.15) < 1e-9);

  const padded = trimMediaTimingSelectionEnd({ ...base, selectionEnd: 8.5, endPadSeconds: 0.5 });
  assert.ok(padded !== null && Math.abs(padded - 5.65) < 1e-9);

  // Speech running through the line end means the subtitle cuts the audio off; keep it.
  assert.equal(
    trimMediaTimingSelectionEnd({ ...base, lineEnd: 5, selectionEnd: 5, endPadSeconds: 0 }),
    null,
  );
  // No speech inside the line at all: keep the subtitle timing rather than guess.
  assert.equal(
    trimMediaTimingSelectionEnd({ ...base, lineStart: 6, selectionEnd: 8, endPadSeconds: 0 }),
    null,
  );
  // A saving below the minimum trim is not worth moving the handle for.
  assert.equal(
    trimMediaTimingSelectionEnd({ ...base, lineEnd: 5.2, selectionEnd: 5.2, endPadSeconds: 0 }),
    null,
  );
  assert.equal(
    trimMediaTimingSelectionEnd({ ...base, peaks: [1], selectionEnd: 8, endPadSeconds: 0 }),
    null,
  );
});

test('review translation follows added lines until the card is back to its own line', () => {
  const base = {
    previousLines: [{ text: '前の行', startTime: 8, endTime: 10 }],
    nextLines: [{ text: '次の行', startTime: 12.1, endTime: 14 }],
    text: '対象の行',
    originalStartTime: 10.1,
    originalEndTime: 12,
    initialTranslation: 'Main translation.',
    initialTranslationLines: [{ text: 'the mined line', startTime: 10, endTime: 12 }],
    translationLines: [
      { text: 'before,', startTime: 7.9, endTime: 10 },
      { text: 'the mined line', startTime: 10, endTime: 12 },
      { text: 'and after,', startTime: 12, endTime: 14 },
    ],
    format: true,
  };
  assert.equal(
    buildMediaTimingReviewTranslation({ ...base, previousCount: 0, nextCount: 0 }),
    'Main translation.',
  );
  assert.equal(
    buildMediaTimingReviewTranslation({ ...base, previousCount: 0, nextCount: 1 }),
    'The mined line and after.',
  );
  assert.equal(
    buildMediaTimingReviewTranslation({ ...base, previousCount: 1, nextCount: 1, format: false }),
    'before, the mined line and after,',
  );
  assert.equal(
    buildMediaTimingReviewTranslation({
      ...base,
      translationLines: [],
      previousCount: 1,
      nextCount: 0,
    }),
    null,
  );
});

test('a widened multi-line sentence keeps its own translations when a line is added', () => {
  const lineA = { text: 'A', startTime: 10, endTime: 12 };
  const lineB = { text: 'B', startTime: 12, endTime: 14 };
  const lineC = { text: 'C', startTime: 14, endTime: 16 };
  assert.equal(
    buildMediaTimingReviewTranslation({
      previousLines: [],
      nextLines: [{ text: '三', startTime: 14, endTime: 16 }],
      // Main widened the card to the primary lines behind A and B.
      text: '一 二',
      originalStartTime: 10,
      originalEndTime: 14,
      previousCount: 0,
      nextCount: 1,
      initialTranslation: 'A B',
      initialTranslationLines: [lineA, lineB],
      translationLines: [lineA, lineB, lineC],
      format: false,
    }),
    'A B C',
  );
});

test('an added line takes the translation the full-track grouping assigned it', () => {
  // Grouped against the whole track, 次 belongs to the long X; regrouping it alone
  // would pick the tightly timed Y instead.
  const lineX = { text: 'X', startTime: 14, endTime: 18 };
  const lineY = { text: 'Y', startTime: 16, endTime: 17 };
  assert.equal(
    buildMediaTimingReviewTranslation({
      previousLines: [],
      nextLines: [{ text: '次', startTime: 16, endTime: 17 }],
      text: '今',
      originalStartTime: 10,
      originalEndTime: 14,
      previousCount: 0,
      nextCount: 1,
      initialTranslation: 'Now',
      initialTranslationLines: [{ text: 'Now', startTime: 10, endTime: 14 }],
      translationLines: [{ text: 'Now', startTime: 10, endTime: 14 }, lineX, lineY],
      lineTranslations: [{ startTime: 16, endTime: 17, lines: [lineX] }],
      format: false,
    }),
    'Now X',
  );
});

test('an on-screen translation stays when lines are added around it', () => {
  assert.equal(
    buildMediaTimingReviewTranslation({
      previousLines: [{ text: '前', startTime: 8, endTime: 10 }],
      nextLines: [{ text: '次', startTime: 12, endTime: 14 }],
      text: '今',
      originalStartTime: 10,
      originalEndTime: 12,
      previousCount: 1,
      nextCount: 1,
      initialTranslation: 'Now.',
      initialTranslationLines: [],
      translationLines: [
        { text: 'Before.', startTime: 8, endTime: 10 },
        { text: 'After.', startTime: 12, endTime: 14 },
      ],
      format: false,
    }),
    'Before. Now. After.',
  );
});
