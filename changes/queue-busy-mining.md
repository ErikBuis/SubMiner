type: fixed
area: anki

- Mining a sentence card while SubMiner is still busy with Anki (the previous card's media, a poll for new cards, a manual update) now queues the card instead of dropping it with "Anki update already in progress". Cards are made in the order they were mined, with the sentence and timing from the moment you mined them.
- A queued card shows "Anki is busy, card queued" once the wait passes half a second, and is skipped with a message if the video changes before its turn.
