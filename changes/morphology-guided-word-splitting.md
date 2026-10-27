type: fixed
area: subtitles

- Fixed subtitle words swallowing the start of the next word (`のメッセージ` split as `のメッセ` + `ー` + `ジ`, `いいんだろうか` read as `医院`, `ヤツでした` as `ヤツデ` + `下`). A bundled morphological analyzer now checks Yomitan's word boundaries, so hover highlights and known-word, N+1, and frequency colors cover the right words. Turn it off with `subtitleStyle.morphologyGuidedSplitting`.
- A wave dash between kana is read as a stretched sound, so `か～くれんぼ` and `バイバ～イ` are looked up as one word.
