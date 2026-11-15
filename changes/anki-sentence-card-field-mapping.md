type: fixed
area: anki

- Sentence cards (`Ctrl/Cmd+S`, `Ctrl/Cmd+Shift+S`) on note types other than Lapis/Kiku now write the sentence and its audio to `ankiConnect.fields.sentence` and `ankiConnect.fields.audio`, like word cards and audio cards. They used to always write to `Sentence` and `SentenceAudio`, so on a note type with other field names the sentence and audio were dropped and Anki could refuse the card as empty. If the note type has no field by the configured name, they fall back to `Sentence` and `SentenceAudio`. With `isLapis` or `isKiku` enabled, `Sentence` and `SentenceAudio` still come first.
