type: fixed
area: overlay

- mpv shows its own subtitles while the overlay is still loading, so a slow start no longer leaves the video without subtitles.
- The overlay loading spinner no longer flickers between two messages, and the "Overlay did not become ready" warning stays on screen long enough to read.
- The overlay loading warning waits 60 seconds instead of 30 before giving up, since loading many Yomitan dictionaries can take about half a minute.
