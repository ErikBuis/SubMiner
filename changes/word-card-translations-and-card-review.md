type: added
area: anki

- New `ankiConnect.behavior.translationOnWordCards` fills the translation field on word cards mined from the dictionary popup, not only on sentence cards.
- New `ankiConnect.behavior.alignSentenceToTranslation` groups primary and secondary subtitle lines into sentences: the card sentence and media widen to every line its translation covers, and overlapping unrelated secondary lines (signs, background TV) stay off the card.
- New `ankiConnect.behavior.formatTranslation` writes card translations starting with a capital letter and turns a trailing comma into a period.
- The media timing review (`ankiConnect.media.reviewTiming`) now shows the word and meaning (`ankiConnect.fields.definition`) being exported and an editable translation that follows added or removed lines until you edit it.
