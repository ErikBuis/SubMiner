type: fixed
area: anki

- Sentence cards now fill the note's `SentenceFurigana` field with readings from the dictionary parser, the same way word cards regenerate it when their sentence changes. They used to leave it empty, so Lapis and Kiku showed those sentences without furigana.
- Audio cards (`Ctrl/Cmd+Shift+A`) now regenerate the furigana when they replace the note's sentence. They used to keep the word card's furigana, so the card showed readings for a sentence it no longer had. If the parser can't read the new sentence, the field is cleared and the card shows the plain sentence.
