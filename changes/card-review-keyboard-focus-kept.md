type: fixed
area: anki

- In the media timing review, pressing Enter on "Frame →", "Frame ←", the screenshot Reset or a line "−"/"+" button no longer drops the keyboard focus. Before, the focus jumped to the clip start handle (or nowhere) as soon as the button got disabled, so the next Enter did nothing. Now the focus stays on the frame buttons while a frame loads and moves to the button next to it when a button can't be pressed anymore. "Keep editing" also puts the focus back on Cancel instead of losing it.
