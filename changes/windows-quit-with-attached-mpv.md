type: fixed
area: overlay

- Windows: closing mpv now also closes SubMiner when the "SubMiner mpv" launcher handed mpv to a SubMiner that was already running. Before, that SubMiner stayed in the tray, and every later launch attached to the same leftover process. A tray SubMiner that only the mpv plugin connects to still stays open.
- Windows: the overlay window no longer lingers as an empty "SubMiner Overlay" taskbar entry after mpv's window closes. It now hides once mpv's window is gone, like it already did when mpv was minimized.
