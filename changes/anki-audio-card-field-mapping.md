type: fixed
area: anki

- Audio cards (`Ctrl/Cmd+Shift+A`) on note types other than Lapis/Kiku now write the sentence and its audio to `ankiConnect.fields.sentence` and `ankiConnect.fields.audio`, like word cards do. They used to always write to `Sentence` and `SentenceAudio`, so on a note type with other field names the card kept its old sentence and audio while the image and MiscInfo moved to the new line. With `isLapis` or `isKiku` enabled, audio cards still prefer `Sentence` and `SentenceAudio`, and fall back to the configured fields when the note does not have them.
