type: fixed
area: anki

- Sentence cards now check that the note type in `ankiConnect.isLapis.sentenceCardModel` exists in Anki before the card review opens, and name that setting when it doesn't, instead of failing with "model was not found" after the review.
