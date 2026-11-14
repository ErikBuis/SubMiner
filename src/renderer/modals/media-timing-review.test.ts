import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CONTROLLER_REVIEW_ACTIONS } from '../../shared/controller-review';
import { parseBracketFurigana } from '../../shared/furigana-markup';
import {
  annotateReviewLine,
  applySentenceLineChange,
  buildMediaTimingReviewTranslation,
  buildMediaTimingReviewTranslationPreview,
  applyTranslationLineChanges,
  MEDIA_TIMING_REVIEW_CONTROLLER_BUTTONS,
  isMediaTimingReviewButtonAvailable,
  isMediaTimingReviewFocusInside,
  mediaTimingReviewArrowDirection,
  pickMediaTimingReviewArrowTarget,
  pickMediaTimingReviewFocusHandoff,
  buildMediaTimingLineSelection,
  buildMediaTimingWaveformPath,
  constrainMediaTimingSelection,
  createMediaTimingPreviewRequestGuard,
  formatMediaTimingTimestamp,
  mediaTimingTimeFromPointer,
  slideMediaTimingSelection,
  wrapMediaTimingReviewFocus,
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
    'The mined line and after, (...)',
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

test('added co-timed lines each take their own assigned translation', () => {
  const go = { text: "- Let's go.", startTime: 16, endTime: 17 };
  const wait = { text: '- Wait.', startTime: 16, endTime: 17 };
  assert.equal(
    buildMediaTimingReviewTranslation({
      previousLines: [],
      nextLines: [
        { text: '－行くぞ', startTime: 16, endTime: 17 },
        { text: '－待って', startTime: 16, endTime: 17 },
      ],
      text: '今',
      originalStartTime: 10,
      originalEndTime: 14,
      previousCount: 0,
      nextCount: 2,
      initialTranslation: 'Now',
      initialTranslationLines: [{ text: 'Now', startTime: 10, endTime: 14 }],
      translationLines: [{ text: 'Now', startTime: 10, endTime: 14 }, go, wait],
      lineTranslations: [
        { text: '－行くぞ', startTime: 16, endTime: 17, lines: [go] },
        { text: '－待って', startTime: 16, endTime: 17, lines: [wait] },
      ],
      format: false,
    }),
    "Now - Let's go. - Wait.",
  );
});

test('an added line whose secondary cue is part of its own text adds no translation', () => {
  assert.equal(
    buildMediaTimingReviewTranslation({
      previousLines: [],
      nextLines: [{ text: '今日はいい天気ですね', startTime: 16, endTime: 18 }],
      text: '今',
      originalStartTime: 10,
      originalEndTime: 14,
      previousCount: 0,
      nextCount: 1,
      initialTranslation: 'Now',
      initialTranslationLines: [{ text: 'Now', startTime: 10, endTime: 14 }],
      translationLines: [
        { text: 'Now', startTime: 10, endTime: 14 },
        { text: '今日は', startTime: 16, endTime: 18 },
      ],
      format: false,
    }),
    'Now',
  );
});

test('an added line whose secondary cue only differs in markup adds no translation', () => {
  assert.equal(
    buildMediaTimingReviewTranslation({
      previousLines: [],
      nextLines: [{ text: 'トム&amp;ジェリー', startTime: 16, endTime: 18 }],
      text: '今',
      originalStartTime: 10,
      originalEndTime: 14,
      previousCount: 0,
      nextCount: 1,
      initialTranslation: 'Now',
      initialTranslationLines: [{ text: 'Now', startTime: 10, endTime: 14 }],
      translationLines: [
        { text: 'Now', startTime: 10, endTime: 14 },
        { text: 'トム&ジェリー', startTime: 16, endTime: 18 },
      ],
      format: false,
    }),
    'Now',
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

test('an added line whose secondary text is its own text adds no translation', () => {
  const same = { text: '次', startTime: 12, endTime: 14 };
  assert.equal(
    buildMediaTimingReviewTranslation({
      previousLines: [],
      nextLines: [same],
      text: '今',
      originalStartTime: 10,
      originalEndTime: 12,
      previousCount: 0,
      nextCount: 1,
      initialTranslation: '',
      initialTranslationLines: [],
      translationLines: [{ text: '今', startTime: 10, endTime: 12 }, same],
      format: false,
    }),
    '',
  );
});

test('review translation shifts add and drop secondary lines at either end', () => {
  const lines = [
    { text: 'Two before,', startTime: 4, endTime: 6 },
    { text: 'one before,', startTime: 6, endTime: 8 },
    { text: 'the mined line', startTime: 8, endTime: 10 },
    { text: 'and after.', startTime: 10, endTime: 12 },
  ];
  const base = {
    previousLines: [],
    nextLines: [],
    text: '対象の行',
    originalStartTime: 8,
    originalEndTime: 10,
    previousCount: 0,
    nextCount: 0,
    initialTranslation: 'The mined line',
    initialTranslationLines: [lines[2]!],
    translationLines: lines,
    format: false,
  };
  const unchanged = buildMediaTimingReviewTranslationPreview(base);
  assert.equal(unchanged.text, 'The mined line');
  assert.deepEqual(
    [
      unchanged.canAddPrevious,
      unchanged.canRemovePrevious,
      unchanged.canAddNext,
      unchanged.canRemoveNext,
    ],
    [true, false, true, false],
  );

  const widened = buildMediaTimingReviewTranslationPreview({
    ...base,
    translationPreviousShift: 5,
    translationNextShift: 1,
  });
  assert.equal(widened.text, 'Two before, one before, the mined line and after.');
  // Shifts past the available lines are clamped, so one press takes them back.
  assert.equal(widened.previousShift, 2);
  assert.equal(widened.canAddPrevious, false);
  assert.equal(widened.canAddNext, false);

  // Dropping lines keeps at least one.
  const narrowed = buildMediaTimingReviewTranslationPreview({
    ...base,
    initialTranslationLines: [lines[1]!, lines[2]!],
    translationPreviousShift: -1,
    translationNextShift: -1,
  });
  assert.equal(narrowed.text, 'the mined line');
  assert.equal(narrowed.previousShift, -1);
  assert.equal(narrowed.nextShift, 0);
  assert.equal(narrowed.canRemovePrevious, false);
  assert.equal(narrowed.canRemoveNext, false);
});

test('review translation shifts keep a translation taken from the screen in the middle', () => {
  const preview = buildMediaTimingReviewTranslationPreview({
    previousLines: [],
    nextLines: [],
    text: '対象の行',
    originalStartTime: 8,
    originalEndTime: 10,
    previousCount: 0,
    nextCount: 0,
    initialTranslation: 'From the screen',
    initialTranslationLines: [],
    translationLines: [
      { text: 'Before', startTime: 6, endTime: 8 },
      { text: 'overlapping', startTime: 8, endTime: 10 },
      { text: 'after', startTime: 10, endTime: 12 },
    ],
    format: false,
    translationPreviousShift: 1,
    translationNextShift: 1,
  });
  assert.equal(preview.text, 'Before From the screen after');
  assert.equal(preview.canRemovePrevious, true);
  assert.equal(preview.canAddNext, false);
});

test('review translation shifts can drop a line added at the other end', () => {
  const lineA = { text: 'A', startTime: 8, endTime: 10 };
  const lineB = { text: 'B', startTime: 10, endTime: 12 };
  const preview = buildMediaTimingReviewTranslationPreview({
    previousLines: [],
    nextLines: [],
    text: '対象の行',
    originalStartTime: 8,
    originalEndTime: 10,
    previousCount: 0,
    nextCount: 0,
    initialTranslation: 'A',
    initialTranslationLines: [lineA],
    translationLines: [lineA, lineB],
    format: false,
    translationPreviousShift: -1,
    translationNextShift: 1,
  });
  assert.equal(preview.text, 'B');
  assert.equal(preview.previousShift, -1);
  assert.equal(preview.nextShift, 1);
  assert.equal(preview.canRemovePrevious, false);
});

test('review translation shifts grow a screen translation from the lines before it', () => {
  // Sorted by start, the long cue comes first although it ends after the clip.
  const preview = buildMediaTimingReviewTranslationPreview({
    previousLines: [],
    nextLines: [],
    text: '対象の行',
    originalStartTime: 8,
    originalEndTime: 10,
    previousCount: 0,
    nextCount: 0,
    initialTranslation: 'From the screen',
    initialTranslationLines: [],
    translationLines: [
      { text: 'Sign', startTime: 0, endTime: 30 },
      { text: 'Before', startTime: 6, endTime: 8 },
    ],
    format: false,
    translationPreviousShift: 1,
  });
  assert.equal(preview.text, 'Before From the screen');
});

test('review translation buttons are available only when a press changes the lines', () => {
  const lines = [
    { text: 'Sign', startTime: 0, endTime: 30 },
    { text: 'Before', startTime: 6, endTime: 8 },
  ];
  const base = {
    previousLines: [],
    nextLines: [],
    text: '対象の行',
    originalStartTime: 8,
    originalEndTime: 10,
    previousCount: 0,
    nextCount: 0,
    initialTranslation: 'From the screen',
    initialTranslationLines: [],
    translationLines: lines,
    format: false,
  };
  // The long sign starts first but runs past the clip, so it is no earlier line.
  const added = buildMediaTimingReviewTranslationPreview({ ...base, translationPreviousShift: 1 });
  assert.equal(added.canAddPrevious, false);
  assert.equal(added.canRemovePrevious, true);
  assert.equal(
    buildMediaTimingReviewTranslationPreview({ ...base, translationPreviousShift: 2 }).text,
    'Before From the screen',
  );
});

test('review translation buttons skip a background line no dialogue line has', () => {
  // Bocchi the Rock! ep. 1 at 00:33: a TV line runs alongside the narration.
  const own = {
    text: 'With no club activity, she comes straight home.',
    startTime: 30.3,
    endTime: 33.72,
  };
  const tv = { text: "And here, we'll stir-fry it a bit.", startTime: 33.72, endTime: 36.85 };
  const narration = { text: 'The only messages she receives…', startTime: 35.35, endTime: 40.94 };
  const preview = buildMediaTimingReviewTranslationPreview({
    previousLines: [],
    nextLines: [],
    text: '部活も入らず 放課後は即帰宅',
    originalStartTime: 30.343,
    originalEndTime: 33.68,
    previousCount: 0,
    nextCount: 0,
    initialTranslation: own.text,
    initialTranslationLines: [own],
    translationLines: [own, tv, narration],
    lineTranslations: [
      { text: '部活も入らず 放課後は即帰宅', startTime: 30.343, endTime: 33.68, lines: [own] },
      { text: '（テレビ番組の音声）', startTime: 33.764, endTime: 34.681, lines: [tv] },
      {
        text: '（ひとり）スマホに届くのは',
        startTime: 35.474,
        endTime: 36.808,
        lines: [narration],
      },
    ],
    format: false,
    translationNextShift: 1,
  });
  assert.equal(preview.text, `${own.text} ${narration.text}`);
});

test('an edited translation keeps the edit when lines come and go at its ends', () => {
  const a = { text: 'Before,', startTime: 6, endTime: 8 };
  const b = { text: 'the mined line', startTime: 8, endTime: 10 };
  const c = { text: 'and after.', startTime: 10, endTime: 12 };
  const lines = (...run: (typeof a)[]) => ({ leadingLines: run, trailingLines: run });
  assert.equal(
    applyTranslationLineChanges({
      text: 'My own wording',
      before: lines(b),
      after: lines(a, b, c),
      format: false,
    }),
    'Before, My own wording and after.',
  );
  // A dropped line leaves only when the edit still starts or ends with it.
  assert.equal(
    applyTranslationLineChanges({
      text: 'before, my wording and after.',
      before: lines(a, b, c),
      after: lines(b),
      format: false,
    }),
    'my wording',
  );
  assert.equal(
    applyTranslationLineChanges({
      text: 'Rewritten completely',
      before: lines(a, b),
      after: lines(b),
      format: false,
    }),
    'Rewritten completely',
  );
  // Formatting moves the continuation mark to the new end.
  assert.equal(
    applyTranslationLineChanges({
      text: 'Lost in that thought, (...)',
      before: lines(b),
      after: lines(b, c),
      format: true,
    }),
    'Lost in that thought, and after.',
  );
});

test('a dropped line is cut from an edit only as whole words at its start or end', () => {
  const no = { text: 'No', startTime: 6, endTime: 8 };
  const mined = { text: 'the mined line', startTime: 8, endTime: 10 };
  const here = { text: 'here.', startTime: 10, endTime: 12 };
  const lines = (...run: (typeof no)[]) => ({ leadingLines: run, trailingLines: run });
  // "No" is not the start of "Nobody", and "here." is not the end of "There.".
  assert.equal(
    applyTranslationLineChanges({
      text: 'Nobody knows',
      before: lines(no, mined),
      after: lines(mined),
      format: false,
    }),
    'Nobody knows',
  );
  assert.equal(
    applyTranslationLineChanges({
      text: 'Over There.',
      before: lines(mined, here),
      after: lines(mined),
      format: false,
    }),
    'Over There.',
  );
  // Spacing and case inside the dropped line do not matter.
  assert.equal(
    applyTranslationLineChanges({
      text: 'no,  my wording\nHERE.',
      before: lines({ ...no, text: 'No,' }, mined, here),
      after: lines(mined),
      format: false,
    }),
    'my wording',
  );
  // An apostrophe or hyphen keeps the letters around it one word.
  for (const [text, dropped, side] of [
    ["It's fine", 'It', 'start'],
    ['Well-known fact', 'Well', 'start'],
    ['rock-solid plan', 'rock-', 'start'],
    ["fine y'all", 'all', 'end'],
    ['a well-known', 'known', 'end'],
  ] as const) {
    const line = { ...no, text: dropped, startTime: side === 'start' ? 6 : 10 };
    const run = side === 'start' ? [line, mined] : [mined, { ...line, endTime: 12 }];
    assert.equal(
      applyTranslationLineChanges({
        text,
        before: lines(...run),
        after: lines(mined),
        format: false,
      }),
      text,
    );
  }
  // Next to spaces or punctuation the line is still cut.
  assert.equal(
    applyTranslationLineChanges({
      text: "I- I'm fine",
      before: lines({ ...no, text: 'I-' }, mined),
      after: lines(mined),
      format: false,
    }),
    "I'm fine",
  );
  // Text written without spaces is still cut where the line ends.
  assert.equal(
    applyTranslationLineChanges({
      text: '你好我的翻译',
      before: lines({ ...no, text: '你好' }, mined),
      after: lines(mined),
      format: false,
    }),
    '我的翻译',
  );
});

test('a continuation mark followed by typed whitespace still moves with the end', () => {
  const mined = { text: 'the mined line', startTime: 8, endTime: 10 };
  const after = { text: 'and after,', startTime: 10, endTime: 12 };
  const lines = (...run: (typeof mined)[]) => ({ leadingLines: run, trailingLines: run });
  assert.equal(
    applyTranslationLineChanges({
      text: 'My own wording and after, (...) \n',
      before: lines(mined, after),
      after: lines(mined),
      format: true,
    }),
    'My own wording',
  );
});

test('an edit that no longer starts or ends with a dropped line stays exactly as typed', () => {
  const before = { text: 'Before,', startTime: 6, endTime: 8 };
  const mined = { text: 'the mined line', startTime: 8, endTime: 10 };
  const lines = (...run: (typeof before)[]) => ({ leadingLines: run, trailingLines: run });
  // Formatting would capitalize this and mark the comma; nothing was cut, so it stays.
  assert.equal(
    applyTranslationLineChanges({
      text: 'something else entirely,  ',
      before: lines(before, mined),
      after: lines(mined),
      format: true,
    }),
    'something else entirely,  ',
  );
});

test('pressing minus after plus takes the added line back out of an edited translation', () => {
  const lines = [
    { text: 'one before,', startTime: 6, endTime: 8 },
    { text: 'the mined line', startTime: 8, endTime: 10 },
    { text: 'and after,', startTime: 10, endTime: 12 },
  ];
  const base = {
    previousLines: [{ text: '前の行', startTime: 6, endTime: 8 }],
    nextLines: [{ text: '次の行', startTime: 10, endTime: 12 }],
    text: '対象の行',
    originalStartTime: 8,
    originalEndTime: 10,
    previousCount: 0,
    nextCount: 0,
    initialTranslation: 'The mined line',
    initialTranslationLines: [lines[1]!],
    translationLines: lines,
    format: true,
  };
  // Mirrors the modal: each press rebuilds the preview, and an edited text only takes the
  // lines that came or went since the last press.
  const press = (
    state: { text: string; lines: ReturnType<typeof buildMediaTimingReviewTranslationPreview> },
    change: Partial<typeof base> & {
      translationPreviousShift?: number;
      translationNextShift?: number;
    },
  ) => {
    const lines = buildMediaTimingReviewTranslationPreview({ ...base, ...change });
    return {
      text: applyTranslationLineChanges({
        text: state.text,
        before: state.lines,
        after: lines,
        format: base.format,
      }),
      lines,
    };
  };
  const opened = { text: 'My own wording', lines: buildMediaTimingReviewTranslationPreview(base) };

  // The translation's own buttons.
  const withPrevious = press(opened, { translationPreviousShift: 1 });
  assert.equal(withPrevious.text, 'One before, My own wording');
  assert.equal(press(withPrevious, { translationPreviousShift: 0 }).text, 'My own wording');
  const withNext = press(opened, { translationNextShift: 1 });
  assert.equal(withNext.text, 'My own wording and after, (...)');
  assert.equal(press(withNext, { translationNextShift: 0 }).text, 'My own wording');

  // The sentence buttons bring the added line's translation along.
  const withLine = press(opened, { nextCount: 1 });
  assert.equal(withLine.text, 'My own wording and after, (...)');
  assert.equal(press(withLine, { nextCount: 0 }).text, 'My own wording');

  // A line added before the edit is taken out the same way.
  const followed = buildMediaTimingReviewTranslationPreview({
    ...base,
    translationPreviousShift: 1,
  });
  assert.equal(followed.text, 'One before, the mined line');
  const tweaked = { text: 'One before, the line I mined', lines: followed };
  assert.equal(press(tweaked, { translationPreviousShift: 0 }).text, 'The line I mined');

  // Minus only looks at the text as it is now: an edit that was typed back to the
  // followed text loses the line like a translation that was never edited.
  const typedBack = { text: 'One before, the mined line', lines: followed };
  assert.equal(press(typedBack, { translationPreviousShift: 0 }).text, 'The mined line');
  const typedBackNext = { ...withNext, text: 'my own wording  AND after, (...)' };
  assert.equal(press(typedBackNext, { translationNextShift: 0 }).text, 'My own wording');

  // Once the added part is rewritten, minus leaves the text alone.
  const rewritten = { ...withPrevious, text: 'Just before, My own wording' };
  assert.equal(
    press(rewritten, { translationPreviousShift: 0 }).text,
    'Just before, My own wording',
  );
});

test('an edited screen translation gets lines on the side they belong to', () => {
  const before = { text: 'Earlier', startTime: 4, endTime: 6 };
  const after = { text: 'later', startTime: 12, endTime: 14 };
  assert.equal(
    applyTranslationLineChanges({
      text: 'Typed text',
      before: { leadingLines: [], trailingLines: [] },
      after: { leadingLines: [before], trailingLines: [after] },
      format: false,
    }),
    'Earlier Typed text later',
  );
});

test('every controller action presses a real button on the review screen', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8');
  const actions = new Set<string>(CONTROLLER_REVIEW_ACTIONS.map((action) => action.id));
  assert.deepEqual(new Set(Object.keys(MEDIA_TIMING_REVIEW_CONTROLLER_BUTTONS)), actions);
  for (const domId of Object.values(MEDIA_TIMING_REVIEW_CONTROLLER_BUTTONS)) {
    assert.match(html, new RegExp(`<button\\s+id="${domId}"`), `missing <button id="${domId}">`);
  }
});

test('controller presses skip disabled buttons and buttons on the hidden step', () => {
  const button = (disabled: boolean, insideHidden: boolean) =>
    ({ disabled, closest: () => (insideHidden ? {} : null) }) as unknown as HTMLButtonElement;

  assert.equal(isMediaTimingReviewButtonAvailable(button(false, false)), true);
  assert.equal(isMediaTimingReviewButtonAvailable(button(true, false)), false);
  assert.equal(isMediaTimingReviewButtonAvailable(button(false, true)), false);
});

test('review lines prefer the note furigana on the card text and generated readings elsewhere', () => {
  const note = parseBracketFurigana(' 今日[きょう]は 晴[は]れ');
  const generated = new Map([
    ['今日は晴れ', parseBracketFurigana(' 今日[こんにち]は 晴[は]れ')],
    ['明日も晴れ', parseBracketFurigana(' 明日[あした]も 晴[は]れ')],
  ]);
  const readings = (segments: ReturnType<typeof annotateReviewLine>) =>
    segments?.filter((segment) => segment.reading).map((segment) => segment.reading);
  // The card's own text reads as the note spells it.
  assert.deepEqual(
    readings(annotateReviewLine({ line: '今日は晴れ', own: true, noteFurigana: note, generated })),
    ['きょう', 'は'],
  );
  // An added line takes its generated readings, not the note's partial match.
  assert.deepEqual(
    readings(annotateReviewLine({ line: '明日も晴れ', own: false, noteFurigana: note, generated })),
    ['あした', 'は'],
  );
  // Without a note field, as on a sentence card, the card text uses generated readings.
  assert.deepEqual(
    readings(annotateReviewLine({ line: '今日は晴れ', own: true, noteFurigana: null, generated })),
    ['こんにち', 'は'],
  );
  assert.equal(
    annotateReviewLine({ line: 'ねえ', own: false, noteFurigana: null, generated }),
    null,
  );
});

test('a button that gets disabled hands the focus to its nearest enabled neighbor', () => {
  const [previous, next, reset] = ['previous', 'next', 'reset'];

  // "Frame →" reached the end: "Frame ←" and Reset are equally near, the earlier one wins.
  assert.equal(
    pickMediaTimingReviewFocusHandoff(
      [
        [previous, false],
        [next, true],
        [reset, false],
      ],
      next,
    ),
    previous,
  );
  // Reset pressed: both frame buttons stay, the nearer one takes the focus.
  assert.equal(
    pickMediaTimingReviewFocusHandoff(
      [
        [previous, false],
        [next, false],
        [reset, true],
      ],
      reset,
    ),
    next,
  );
  // Focus elsewhere, or on a button that stays enabled, stays put.
  assert.equal(
    pickMediaTimingReviewFocusHandoff(
      [
        [previous, true],
        [next, false],
      ],
      'translation',
    ),
    null,
  );
  assert.equal(
    pickMediaTimingReviewFocusHandoff(
      [
        [previous, true],
        [next, false],
      ],
      next,
    ),
    null,
  );
  // With every button of the group disabled there is nothing to hand the focus to.
  assert.equal(
    pickMediaTimingReviewFocusHandoff(
      [
        [previous, true],
        [next, true],
      ],
      next,
    ),
    null,
  );
});

test('the frame and line buttons keep the keyboard focus when they get disabled', () => {
  const source = readFileSync('src/renderer/modals/media-timing-review.ts', 'utf8');
  for (const id of [
    'FramePrevious',
    'FrameNext',
    'FrameReset',
    'PrevAdd',
    'PrevRemove',
    'NextAdd',
    'NextRemove',
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`mediaTimingReview${id}\\.disabled\\s*=`),
      `mediaTimingReview${id} is disabled without setButtonsDisabled`,
    );
  }
});

test('Tab wraps focus around the review instead of leaving it', () => {
  const [first, middle, last] = ['first', 'middle', 'last'].map(
    (id) => ({ id }) as unknown as HTMLElement,
  ) as [HTMLElement, HTMLElement, HTMLElement];
  const targets = [first, middle, last];
  const outside = { id: 'outside' } as unknown as HTMLElement;

  // Inside the list the browser's own Tab move is kept.
  assert.equal(wrapMediaTimingReviewFocus(targets, first, false), null);
  assert.equal(wrapMediaTimingReviewFocus(targets, middle, true), null);
  // At the ends focus wraps around.
  assert.equal(wrapMediaTimingReviewFocus(targets, last, false), first);
  assert.equal(wrapMediaTimingReviewFocus(targets, first, true), last);
  // Focus outside the dialog comes back in at the matching end.
  assert.equal(wrapMediaTimingReviewFocus(targets, outside, false), first);
  assert.equal(wrapMediaTimingReviewFocus(targets, null, true), last);
  assert.equal(wrapMediaTimingReviewFocus([], first, false), null);
});

test('focus on the dialog root counts as outside for Tab and the arrow keys', () => {
  const inside = { id: 'inside' } as unknown as Node;
  const outside = { id: 'outside' } as unknown as Node;
  const modal = { contains: (node: Node | null) => node === modal || node === inside } as Node;
  assert.equal(isMediaTimingReviewFocusInside(modal, inside), true);
  // A click on plain text in the dialog focuses the root.
  assert.equal(isMediaTimingReviewFocusInside(modal, modal), false);
  assert.equal(isMediaTimingReviewFocusInside(modal, outside), false);
  assert.equal(isMediaTimingReviewFocusInside(modal, null), false);
});

test('arrow keys move to the control next to the focused one on screen', () => {
  const box = (left: number, top: number, width = 60, height = 24) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
  });
  // Row 1: header buttons on the right. Row 2: a full-width translation field.
  // Row 3: three buttons. Row 4: one button far right, lower down.
  const resetAll = box(500, 0);
  const cancel = box(570, 0);
  const translation = box(0, 50, 640, 50);
  const left = box(0, 130);
  const middle = box(290, 130);
  const right = box(580, 130);
  const exportCard = box(580, 300);
  const boxes = [resetAll, cancel, translation, left, middle, right, exportCard];
  const pick = (from: number, direction: Parameters<typeof pickMediaTimingReviewArrowTarget>[2]) =>
    pickMediaTimingReviewArrowTarget(boxes[from]!, boxes, direction, from);

  // Left and right stay on the row and stop at its ends.
  assert.equal(pick(3, 'right'), 4);
  assert.equal(pick(4, 'right'), 5);
  assert.equal(pick(5, 'right'), -1);
  assert.equal(pick(4, 'left'), 3);
  assert.equal(pick(3, 'left'), -1);
  assert.equal(pick(2, 'left'), -1);
  assert.equal(pick(1, 'left'), 0);
  // Up and down take the next control above or below, the best lined up first.
  assert.equal(pick(2, 'up'), 0);
  assert.equal(pick(2, 'down'), 4);
  assert.equal(pick(3, 'up'), 2);
  assert.equal(pick(5, 'down'), 6);
  // Nothing lined up below: the only control below still counts.
  assert.equal(pick(3, 'down'), 6);
  assert.equal(pick(6, 'up'), 5);
  assert.equal(pick(6, 'down'), -1);
  assert.equal(pick(0, 'up'), -1);

  // A control straight below wins over a slightly nearer one far off to the side.
  const from = box(0, 0);
  const offSide = box(200, 40);
  const straight = box(0, 150);
  assert.equal(pickMediaTimingReviewArrowTarget(from, [offSide, straight], 'down'), 1);
});

test('arrow directions come from the arrow keys only', () => {
  assert.equal(mediaTimingReviewArrowDirection('ArrowUp'), 'up');
  assert.equal(mediaTimingReviewArrowDirection('ArrowDown'), 'down');
  assert.equal(mediaTimingReviewArrowDirection('ArrowLeft'), 'left');
  assert.equal(mediaTimingReviewArrowDirection('ArrowRight'), 'right');
  assert.equal(mediaTimingReviewArrowDirection('Enter'), null);
});

test('keyboard navigation skips the mouse-only handles and screenshot slider', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8');
  for (const id of [
    'mediaTimingReviewStartHandle',
    'mediaTimingReviewEndHandle',
    'mediaTimingReviewFrameSlider',
  ]) {
    const tag = html.match(new RegExp(`<[a-z]+\\s+id="${id}"[^>]*>`))?.[0] ?? '';
    assert.match(tag, /tabindex="-1"/, `${id} should be out of the Tab order`);
  }
  // The translation only takes typing after Enter or a click.
  const translation = html.match(/<textarea\s+id="mediaTimingReviewTranslation"[^>]*>/)?.[0] ?? '';
  assert.match(translation, /\sreadonly\s/);
  // So does the sentence, whose subtitle lines are a Tab and arrow-key stop of their own.
  const sentence = html.match(/<textarea\s+id="mediaTimingReviewSentence"[^>]*>/)?.[0] ?? '';
  assert.match(sentence, /\sreadonly\s/);
  const lines = html.match(/<blockquote\s+id="mediaTimingReviewText"[^>]*>/)?.[0] ?? '';
  assert.match(lines, /tabindex="0"/);
});

test('lines added to or removed from a typed sentence go in or out at its ends', () => {
  const typed = '荷物が届くのは、明日かな';
  const withPrevious = applySentenceLineChange({
    text: typed,
    line: 'まだ来てないんだよね',
    side: 'previous',
    added: true,
  });
  assert.equal(withPrevious, 'まだ来てないんだよね 荷物が届くのは、明日かな');
  const withBoth = applySentenceLineChange({
    text: withPrevious,
    line: 'じゃあ、一緒に待とうか',
    side: 'next',
    added: true,
  });
  assert.equal(withBoth, 'まだ来てないんだよね 荷物が届くのは、明日かな じゃあ、一緒に待とうか');
  assert.equal(
    applySentenceLineChange({
      text: withBoth,
      line: 'まだ来てないんだよね',
      side: 'previous',
      added: false,
    }),
    '荷物が届くのは、明日かな じゃあ、一緒に待とうか',
  );
  assert.equal(
    applySentenceLineChange({
      text: withBoth,
      line: 'じゃあ、一緒に待とうか',
      side: 'next',
      added: false,
    }),
    'まだ来てないんだよね 荷物が届くのは、明日かな',
  );
});

test('a removed line the user rewrote stays in the typed sentence', () => {
  const typed = 'まだ来てないね 荷物が届くのは明日かな';
  assert.equal(
    applySentenceLineChange({
      text: typed,
      line: 'まだ来てないんだよね',
      side: 'previous',
      added: false,
    }),
    typed,
  );
  // Adding to an emptied sentence gives just the line; an empty line changes nothing.
  assert.equal(
    applySentenceLineChange({ text: '  ', line: 'うん', side: 'next', added: true }),
    'うん',
  );
  assert.equal(
    applySentenceLineChange({ text: typed, line: ' ', side: 'next', added: true }),
    typed,
  );
});
