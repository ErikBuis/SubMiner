type: added
area: anki

- `Tab` and `Shift+Tab` in the card review reach every control and wrap around inside the dialog, with a blue focus outline.
- After `Tab`, the arrow keys move the highlight too, to the control above, below, left or right of it on screen.
- `Enter` presses the focused button or ticks the focused checkbox. `Space` always previews, even on a focused button. Export moved from `Enter` to `Ctrl/Cmd+Enter`.
- The translation only takes typing after a click or `Enter` on it. While typing, `Enter` adds a line break and `Escape` stops typing and keeps the dialog open; the next `Escape` cancels as before.
- The edge handles and the screenshot slider are mouse-only now: Tab and the arrow keys skip them, and the slider ignores keys. The nudge and Frame buttons do the same from the keyboard. Arrow keys still nudge an edge you clicked.
