# Before/after visuals for PRs 59-61

These were recorded on Windows 11 with a single 2560x1440 display at 125% scaling. "Before" is `test/lwnmod-main` (4cdaf5d) and each "after" is that branch plus one fix: `test/lwnmod-59` (deb5d85), `test/lwnmod-close` (07baf17) and `test/lwnmod-position` (342fca4). mpv was paused on a subtitle line at 130 s of Bocchi the Rock! episode 1. A plain dark window sits behind mpv to hide the rest of the desktop.

## PR 59: the overlay follows a dragged mpv window

In `59-before.gif` and `59-after.gif`, a real mouse drag moves mpv's title bar 350 px right and 120 px down over about 1.7 s, pauses, and moves it back.

- Before: the overlay jumps after mpv about every 270 ms. It trails mpv by 27 px on average and by up to 63 px.
- After: the overlay moves with mpv on almost every frame (117 position updates, about 34 ms apart). The average offset is 0.4 px and the largest is 6 px.

## PR 60: SubMiner stays after mpv closes

In this test a tray SubMiner was started with `--background`, then mpv was launched with `--launch-mpv <video>` and closed with WM_CLOSE.

- Before (`60-before.txt`): 8 s after mpv closed, SubMiner was still running, and its now ownerless "SubMiner Overlay" window was still visible.
- After (`60-after.txt`): SubMiner quit together with mpv.
- The two taskbar screenshots look the same. SubMiner has no taskbar button in either build, and its tray icon sits in the collapsed overflow area.

## PR 61: subtitles in the top-left corner

In this test a tray SubMiner was started, then mpv was launched and closed. Next the leftover "SubMiner Overlay" window was closed with WM_CLOSE, while SubMiner itself kept running. Finally mpv was launched again, which made SubMiner create a new overlay window.

- Before (`61-before.png`): the new overlay window sits at 0,0 with its default size of 1000x750 px instead of on mpv. The subtitle shows up near the left edge of the screen, around the middle, partly outside mpv.
- After (`61-after.png`): the new overlay window is placed on mpv (450,200 to 2110,1173), and the subtitle is at the bottom center of the video.
- The window lists and hwnds for every step are in `61-before.txt` and `61-after.txt`.
