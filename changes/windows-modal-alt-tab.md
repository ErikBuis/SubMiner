type: fixed
area: overlay

- Fixed SubMiner dialogs (such as the card review, runtime options, and Jimaku dialogs) on Windows staying drawn on top of every other app after alt+tab. Dialogs now stay above mpv only, so other apps cover them and they come back with mpv.
- Fixed an open dialog on Windows staying attached to the old mpv window when SubMiner switches to a new one.
- Fixed the main overlay staying hidden on Windows after mpv was closed while a SubMiner dialog was open.
