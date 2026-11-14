import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alignSentenceTranslation,
  assignLineTranslations,
  buildSentenceTranslationGroups,
  formatCardTranslation,
  isSourceLanguageText,
  joinSubtitleLineTexts,
  type TimedSubtitleText,
} from './sentence-translation-alignment';

const line = (text: string, startTime: number, endTime: number): TimedSubtitleText => ({
  text,
  startTime,
  endTime,
});

test('a translation covering two primary lines groups them into one sentence', () => {
  const primary = [
    line('あの', 10, 11),
    line('今日は', 11.2, 12.5),
    line('いい天気ですね', 12.6, 14),
    line('次の文', 15, 16),
  ];
  const secondary = [line('Nice weather today, huh?', 11.1, 14.1), line('Next.', 15, 16)];
  const groups = buildSentenceTranslationGroups(primary, secondary);
  assert.equal(groups[0]!.secondary, null);
  assert.equal(groups[1], groups[2]);
  assert.deepEqual([groups[1]!.from, groups[1]!.to], [1, 2]);
  assert.equal(groups[3]!.secondary?.text, 'Next.');
});

test('mining one line of a split sentence keeps that line and resolves its translation', () => {
  const primary = [line('今日は', 11.2, 12.5), line('いい天気ですね', 12.6, 14)];
  const secondary = [line('Nice weather today, huh?', 11.1, 14.1)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 12.6,
    endTime: 14,
  });
  assert.equal(aligned?.text, 'いい天気ですね');
  assert.equal(aligned?.translation, 'Nice weather today, huh?');
});

test('an overlapping unrelated secondary line (background TV) is left out', () => {
  // Bocchi the Rock! ep. 1 at 00:37: two lines of a cooking show on TV are on screen
  // during the narration's line.
  const primary = [
    line('（ひとり）スマホに届くのは', 35.474, 36.808),
    line('親からのメッセージか\nクーポンのお知らせだけ', 37.392, 41.146),
  ];
  const secondary = [
    line(
      'The only messages she receives\nare from either her parents or advertisers.',
      35.36,
      40.95,
    ),
    line("There's a lot of vegetables,", 36.86, 38.99),
    line('so you can probably make it quickly\nif you cut them in advance.', 39.03, 42.74),
  ];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 37.392,
    endTime: 41.146,
  });
  assert.equal(aligned?.text, '親からのメッセージか クーポンのお知らせだけ');
  assert.equal(
    aligned?.translation,
    'The only messages she receives are from either her parents or advertisers.',
  );
});

test('sound cues do not pull a dialogue line into a background line', () => {
  // Bocchi the Rock! ep. 1 at 00:34: two sound cues stretch the TV line over the dialogue,
  // whose sentence continues on the next line under the narration's translation.
  const primary = [
    line('（テレビ番組の音声）', 33.764, 34.681),
    line('（スマホの通知音）', 34.765, 35.39),
    line('（ひとり）スマホに届くのは', 35.474, 36.808),
    line('親からのメッセージか\nクーポンのお知らせだけ', 37.392, 41.146),
  ];
  const narration = line(
    '<i>The only messages she receives\nare from either her parents or advertisers.</i>',
    35.35,
    40.94,
  );
  const secondary = [line("{\\an8}And here, we'll stir-fry it a bit.", 33.72, 36.85), narration];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 35.474,
    endTime: 36.808,
  });
  assert.equal(aligned?.translation, narration.text.replace('\n', ' '));
  // A sound cue still takes an event that covers nothing else.
  const laugh = buildSentenceTranslationGroups(
    [line('（笑い声）', 50, 51)],
    [line('(laughs)', 50, 51)],
  );
  assert.equal(laugh[0]!.secondary?.text, '(laughs)');
});

test('a line no secondary event claims takes the event it overlaps most', () => {
  const primary = [line('長い台詞', 0, 10)];
  const secondary = [line('Short.', 0, 2), line('Longer bit.', 2, 6)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 0,
    endTime: 10,
  });
  assert.equal(aligned?.translation, 'Longer bit.');
});

test('alignment returns null when the mined range matches no primary line', () => {
  assert.equal(
    alignSentenceTranslation({
      primaryLines: [line('一', 0, 1)],
      secondaryLines: [],
      startTime: 5,
      endTime: 6,
    }),
    null,
  );
});

test('a sentence ends at its latest cue, not at the cue that starts last', () => {
  const primary = [line('長い台詞', 0, 10), line('短い', 2, 3)];
  const secondary = [line('The whole thing.', 0, 10)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 0,
    endTime: 10,
  });
  assert.equal(aligned?.text, '長い台詞 短い');
  assert.equal(aligned?.endTime, 10);
});

test('a line repeated by a simultaneous cue is joined once, a later repeat stays', () => {
  assert.equal(
    joinSubtitleLineTexts([
      line('First line\nSecond line', 0, 2),
      line('First line', 0, 2),
      line('First line', 5, 6),
    ]),
    'First line Second line First line',
  );
});

test('a long sign starting between two mined lines stays out of the sentence', () => {
  const primary = [line('一', 0, 1), line('看板', 0.1, 10), line('二', 1, 2)];
  const secondary = [line('One.', 0, 1), line('SIGN', 0.1, 10), line('Two.', 1, 2)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 0,
    endTime: 2,
  });
  assert.equal(aligned?.text, '一 二');
  assert.equal(aligned?.translation, 'One. Two.');
});

test('a dialogue line under a long sign takes its own translation on a tie', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('看板', 0, 10), line('一', 1, 2)],
    secondaryLines: [line('SIGN', 0, 10), line('One.', 1, 2)],
    startTime: 1,
    endTime: 2,
  });
  assert.equal(aligned?.text, '一');
  assert.equal(aligned?.translation, 'One.');
});

test('mined lines missing from the card sentence are left out', () => {
  const primary = [line('長い台詞です', 0, 4), line('看板', 1, 2)];
  const secondary = [line('A long line.', 0, 4), line('SIGN', 1, 2)];
  const withSentence = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 0,
    endTime: 4,
    sentenceText: '長い台詞です',
  });
  assert.equal(withSentence?.translation, 'A long line.');
  // Text that matches no line keeps every mined line.
  const unmatched = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 0,
    endTime: 4,
    sentenceText: 'something else',
  });
  assert.equal(unmatched?.translation, 'A long line. SIGN');
});

test('a mined line counts as in the sentence without its speaker label', () => {
  // Bocchi the Rock! ep. 1 around 07:00: the card sentence drops the label （ひとり）.
  const primary = [
    line('（ひとり）かっ… かっこいい～！', 419.732, 422.485),
    line('一気にバンド女子だ', 422.569, 424.279),
  ];
  const secondary = [
    line('I look... super cool!', 419.78, 422.62),
    line("I'm already a total rocker chick!", 422.62, 424.54),
  ];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 419.732,
    endTime: 424.279,
    sentenceText: 'かっ… かっこいい～！ 一気にバンド女子だ',
  });
  assert.equal(aligned?.translation, "I look... super cool! I'm already a total rocker chick!");
});

test('a line holding only a label stays out of a sentence without it', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('（歓声）', 0, 2), line('一', 2, 4)],
    secondaryLines: [line('(Cheering)', 0, 2), line('One.', 2, 4)],
    startTime: 0,
    endTime: 4,
    sentenceText: '一',
  });
  assert.equal(aligned?.translation, 'One.');
});

test('a slightly offset dialogue translation beats a sign covering the line', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('看板', 0, 10), line('一', 1, 2)],
    secondaryLines: [line('SIGN', 0, 10), line('One.', 0.9, 2.1)],
    startTime: 1,
    endTime: 2,
  });
  assert.equal(aligned?.translation, 'One.');
});

test('a sign that lines up with a whole shot does not win its dialogue lines', () => {
  // Bocchi the Rock! ep. 1 at 14:46: the sign "God" stays up for three dialogue lines and
  // fits their combined span better than either translation fits its own lines.
  const sign = (text: string, startTime: number, endTime: number): TimedSubtitleText => ({
    ...line(text, startTime, endTime),
    isSign: true,
  });
  const primary = [
    line('ソロ弾きは最強でも', 886.45, 887.83),
    line('バンドになるとミジンコ以下', 887.91, 889.95),
    line('最弱になるのだ！', 890.04, 891.7),
  ];
  const secondary = [
    line('She might be an awesome solo player,', 886.33, 888.04),
    sign('God', 886.33, 891.76),
    line("but in a band she's rock bottom,\nbelow even water fleas!", 888.04, 891.76),
  ];
  const translationOf = (index: number) =>
    alignSentenceTranslation({
      primaryLines: primary,
      secondaryLines: secondary,
      startTime: primary[index]!.startTime,
      endTime: primary[index]!.endTime,
    })?.translation;
  assert.equal(translationOf(0), 'She might be an awesome solo player,');
  assert.equal(translationOf(1), "but in a band she's rock bottom, below even water fleas!");
  assert.equal(translationOf(2), "but in a band she's rock bottom, below even water fleas!");
  // Without the sign marker (an SRT track), timing alone decides, as before.
  const unmarked = secondary.map(({ text, startTime, endTime }) => line(text, startTime, endTime));
  assert.equal(
    alignSentenceTranslation({
      primaryLines: primary,
      secondaryLines: unmarked,
      startTime: 890.04,
      endTime: 891.7,
    })?.translation,
    'God',
  );
});

test('a sign still translates a line that no dialogue event covers', () => {
  const sign: TimedSubtitleText = { ...line('BOCCHI THE ROCK!', 260.12, 264), isSign: true };
  const aligned = alignSentenceTranslation({
    primaryLines: [line('ぼっち・ざ・ろっく！', 260.2, 263.9)],
    secondaryLines: [sign, line('Earlier line.', 255, 260.3)],
    startTime: 260.2,
    endTime: 263.9,
  });
  assert.equal(aligned?.translation, 'BOCCHI THE ROCK!');
});

test('an unclaimed line prefers the dialogue event it overlaps over a sign', () => {
  // Neither covers 60% of the line, and the sign covers more of it than the dialogue.
  const sign: TimedSubtitleText = { ...line('SIGN', 0, 5.4), isSign: true };
  const aligned = alignSentenceTranslation({
    primaryLines: [line('長い台詞', 2, 8)],
    secondaryLines: [sign, line('The end of it.', 5.5, 8)],
    startTime: 2,
    endTime: 8,
  });
  assert.equal(aligned?.translation, 'The end of it.');
});

test('two speakers sharing an interval keep both translations', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('－行くぞ', 1, 3), line('－待って', 1, 3)],
    secondaryLines: [line("- Let's go.", 1, 3), line('- Wait.', 1, 3)],
    startTime: 1,
    endTime: 3,
  });
  assert.equal(aligned?.translationLines.length, 2);
});

test('the second of two co-timed speakers takes the other dialogue line, not a sign', () => {
  const sign: TimedSubtitleText = { ...line('SIGN', 1, 3), isSign: true };
  const aligned = alignSentenceTranslation({
    primaryLines: [line('行くぞ', 1, 3), line('待って', 1, 3)],
    secondaryLines: [line("Let's go.", 1, 3), sign, line('Wait.', 1, 3)],
    startTime: 1,
    endTime: 3,
  });
  assert.equal(aligned?.translation, "Let's go. Wait.");
});

test('consecutive lines sharing a translation do not take a co-timed sign', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('今日は', 0, 1), line('いい天気', 1, 2)],
    secondaryLines: [line('Nice weather today.', 0, 2), line('SIGN', 0, 2)],
    startTime: 0,
    endTime: 2,
  });
  assert.equal(aligned?.translation, 'Nice weather today.');
});

test('mining one of two co-timed speakers keeps its own translation', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('－行くぞ', 1, 3), line('－待って', 1, 3)],
    secondaryLines: [line("- Let's go.", 1, 3), line('- Wait.', 1, 3)],
    startTime: 1,
    endTime: 3,
    sentenceText: '－待って',
  });
  assert.equal(aligned?.translation, '- Wait.');
});

test('a co-timed cue repeating another line reuses its translation', () => {
  const secondary = [line("Let's go.\nWait.", 1, 3), line('SIGN', 1, 3)];
  for (const primary of [
    [line('行くぞ\n待って', 1, 3), line('行くぞ', 1, 3)],
    [line('行くぞ', 1, 3), line('行くぞ\n待って', 1, 3)],
  ]) {
    const aligned = alignSentenceTranslation({
      primaryLines: primary,
      secondaryLines: secondary,
      startTime: 1,
      endTime: 3,
    });
    assert.equal(aligned?.translation, "Let's go. Wait.");
  }
});

test('one cue holding two speakers takes both co-timed dialogue translations', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('－行くぞ\n－待って', 1, 3)],
    secondaryLines: [line("- Let's go.", 1, 3), line('- Wait.', 1, 3), line('SIGN', 1, 3)],
    startTime: 1,
    endTime: 3,
  });
  assert.equal(aligned?.translation, "- Let's go. - Wait.");
});

test('a wrapped two-line cue does not take a co-timed sign', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('今日は\nいい天気ですね', 1, 3)],
    secondaryLines: [line('Nice weather today.', 1, 3), line('SIGN', 1, 3)],
    startTime: 1,
    endTime: 3,
  });
  assert.equal(aligned?.translation, 'Nice weather today.');
});

test('co-timed speakers share a combined dialogue cue and leave a sign out', () => {
  const primary = [line('－行くぞ', 1, 3), line('－待って', 1, 3)];
  for (const secondary of [
    [line('SIGN', 1, 3), line("- Let's go.\n- Wait.", 1, 3)],
    [line("- Let's go.\n- Wait.", 1, 3), line('SIGN', 1, 3)],
  ]) {
    for (const sentenceText of ['－待って', undefined]) {
      const aligned = alignSentenceTranslation({
        primaryLines: primary,
        secondaryLines: secondary,
        startTime: 1,
        endTime: 3,
        ...(sentenceText ? { sentenceText } : {}),
      });
      assert.equal(aligned?.translation, "- Let's go. - Wait.");
    }
  }
});

test('a two-speaker cue prefers dialogue cues over a sign that won the timing tie', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('－行くぞ\n－待って', 1, 3)],
    secondaryLines: [line('SIGN', 1, 3), line("- Let's go.", 1, 3), line('- Wait.', 1, 3)],
    startTime: 1,
    endTime: 3,
  });
  assert.equal(aligned?.translation, "- Let's go. - Wait.");
});

test('consecutive dialogue lines share their translation over a co-timed one', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('－今日は', 0, 1), line('－いい天気ですね', 1, 2)],
    secondaryLines: [line('- Nice weather today.', 0, 2), line('- Background TV.', 0, 2)],
    startTime: 1,
    endTime: 2,
  });
  assert.equal(aligned?.translation, '- Nice weather today.');
});

test('a two-speaker cue whose first speaker wraps keeps both translations', () => {
  const aligned = alignSentenceTranslation({
    primaryLines: [line('－今日は\nいい天気だね\n－そうだね', 1, 3)],
    secondaryLines: [line('- Nice weather today.', 1, 3), line('- Yeah.', 1, 3)],
    startTime: 1,
    endTime: 3,
  });
  assert.equal(aligned?.translation, '- Nice weather today. - Yeah.');
});

test('mining one line of a split sentence widens to the whole sentence', () => {
  const primary = [line('今日は', 11.2, 12.5), line('いい天気ですね', 12.6, 14)];
  const secondary = [line('Nice weather today, huh?', 11.1, 14.1)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 12.6,
    endTime: 14,
    widenSentence: true,
  });
  assert.equal(aligned?.text, '今日は いい天気ですね');
  assert.equal(aligned?.startTime, 11.2);
  assert.equal(aligned?.endTime, 14);
  assert.equal(aligned?.translation, 'Nice weather today, huh?');
});

test('widening respects the maximum sentence length', () => {
  const primary = [line('一', 0, 10), line('二', 10, 20), line('三', 20, 30)];
  const secondary = [line('One two three.', 0, 30)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 10,
    endTime: 20,
    widenSentence: true,
    maxSentenceSeconds: 25,
  });
  assert.equal(aligned?.text, '二');
  assert.equal(aligned?.translation, 'One two three.');
});

test('formatCardTranslation capitalizes and marks a comma-ended line as continuing', () => {
  assert.equal(formatCardTranslation('lost in that thought,'), 'Lost in that thought, (...)');
  assert.equal(formatCardTranslation('"so what,"'), '"So what," (...)');
  assert.equal(formatCardTranslation('<i>wait,</i>'), '<i>Wait,</i> (...)');
  assert.equal(formatCardTranslation('それで、'), 'それで、(...)');
  assert.equal(formatCardTranslation('two\nlines'), 'Two lines');
  assert.equal(formatCardTranslation('Already fine!'), 'Already fine!');
  assert.equal(formatCardTranslation('...and then,'), '...and then, (...)');
  assert.equal(formatCardTranslation('   '), '');
});

test('widening reaches across a sign with its own translation', () => {
  const primary = [line('前半', 0, 1), line('看板', 1.5, 2.5), line('後半', 3, 4)];
  const secondary = [line('First half, second half.', 0, 4.2), line('SIGN', 1.5, 2.5)];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 3,
    endTime: 4,
    widenSentence: true,
  });
  assert.equal(aligned?.text, '前半 後半');
  assert.equal(aligned?.startTime, 0);
  assert.equal(aligned?.translation, 'First half, second half.');
});

test('assignLineTranslations gives co-timed speakers their own translations', () => {
  const assigned = assignLineTranslations(
    [line('－行くぞ', 1, 3), line('－待って', 1, 3), line('今日は', 4, 5), line('いい天気', 5, 6)],
    [line("- Let's go.", 1, 3), line('- Wait.', 1, 3), line('Nice weather today.', 4, 6)],
  );
  assert.deepEqual(
    assigned.map(({ translationLines }) => translationLines.map((entry) => entry.text)),
    [["- Let's go."], ['- Wait.'], ['Nice weather today.'], ['Nice weather today.']],
  );
});

test('isSourceLanguageText rejects source cues that are separate pieces of the sentence', () => {
  assert.equal(
    isSourceLanguageText(['今日は', '明日も'], '今日はいい天気ですね 明日も晴れます'),
    true,
  );
  assert.equal(isSourceLanguageText(['Nice weather.', 'Sunny tomorrow.'], '今日は 明日も'), false);
});

test('isSourceLanguageText keeps literal comparison signs apart from tags', () => {
  assert.equal(isSourceLanguageText(['1 < 2 et 3 > 2'], '1 < 2 and 3 > 2'), false);
  assert.equal(isSourceLanguageText(['<i>今日は</i>'], '今日は'), true);
});

test('widening keeps out a mined-range line the card sentence left out', () => {
  // One translation covers the whole sentence and a sign inside it.
  const primary = [
    line('前半', 0, 1),
    line('看板', 1.5, 2.5),
    line('中盤', 3, 4),
    line('後半', 4, 6),
  ];
  const aligned = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: [line('The whole sentence.', 0, 6)],
    startTime: 0,
    endTime: 4,
    sentenceText: '前半 中盤',
    widenSentence: true,
  });
  assert.equal(aligned?.text, '前半 中盤 後半');
});

test('widening follows the mined speaker, not another speaker sharing the interval', () => {
  const primary = [line('Aの一', 0, 2), line('Bの台詞', 0, 2), line('Aの二', 2, 4)];
  const secondary = [line('A says this.', 0, 4), line('B says that.', 0, 4)];
  const plain = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 0,
    endTime: 2,
    sentenceText: 'Bの台詞',
  });
  const widened = alignSentenceTranslation({
    primaryLines: primary,
    secondaryLines: secondary,
    startTime: 0,
    endTime: 2,
    sentenceText: 'Bの台詞',
    widenSentence: true,
  });
  assert.equal(widened?.text, plain?.text);
  assert.equal(widened?.translation, plain?.translation);
});
