type: fixed
area: anki

- mpv's own keys and mouse buttons no longer do anything while the media timing review is open. Before, `Space`, `P`, seeking, volume, or `q` pressed in the mpv window (for example after alt+tab back to it, or a click on the video) changed playback behind the dialog. The window's close button still quits mpv, and if SubMiner crashes with the dialog open, the mpv plugin gives mpv its keys back about 3 seconds after the next key press.
