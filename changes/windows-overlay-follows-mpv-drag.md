type: fixed
area: overlay

- Windows: the overlay and open dialogs now move together with the mpv window while you drag it, instead of trailing behind and jumping about four times a second. SubMiner listens to Windows' window-move events for mpv instead of only checking mpv's position every 250 ms.
