type: fixed
area: anki

- Sentence cards pick their translation by subtitle timing from the parsed tracks, so unrelated overlapping secondary lines (signs, a TV in the background) or the next line no longer end up in the translation field. Timing follows mpv's subtitle delays, so a track retimed with `sub-delay` still gets the line shown beside it.
- Combined sentence cards whose media hits `media.maxMediaDuration` still get the translation of every combined line.
- A combined line that starts with a speaker label, such as `（ひとり）`, keeps its translation when the card sentence leaves the label out.
