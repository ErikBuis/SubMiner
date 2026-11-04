type: changed
area: anki

- The card review's timing buttons now sit inside the waveform panel as −2.0s −0.1s +0.1s +2.0s for the start, Reset, and the same for the end. Moving an edge past the visible timeline widens the view, so the separate Earlier and Later buttons and the visible range times are gone.
- The start is always yellow and the end always purple, on the times, the handles and the buttons. The edge you drag or nudge gets its own highlight, so the focused start handle no longer looks selected when the review opens.
- Loading and "No waveform" notes now show inside the waveform, and the drag hint moved to the key hints.
- Controller: `L2` / `R2` + D-pad left/right move the start / end by 2 seconds and replace Earlier/Later on D-pad left/right. Remapped `showEarlier` / `showLater` review bindings are ignored with an unknown-action warning; map the new Start/End ±2.0s actions in `Alt+C` instead.
