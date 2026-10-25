type: fixed
area: overlay

- Configured mouse bindings (for example `MBTN_LEFT` -> `cycle pause`) no longer fire for clicks inside SubMiner UI: modals such as the review dialog and playlist browser, the dictionary popup, the subtitle sidebar, notifications, or subtitle text. They also stay quiet while the playlist browser or a dictionary popup is open.
- Keys the playlist browser does not use no longer fall through to playback keybindings.
- The overlay stays interactive while the TsukiHime, review, playlist browser, character dictionary, or changelog modal is open, instead of dropping back to click-through on a focus change and letting clicks reach mpv.
- Seeking to another subtitle line while paused now closes the stale dictionary popup and keeps playback paused.
