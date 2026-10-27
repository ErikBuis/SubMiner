type: fixed
area: overlay

- Windows: the overlay no longer fails to appear now and then at startup. Finding the mpv window reads mpv's command line through PowerShell, and on a busy startup that lookup could exceed its 1.5 s timeout on every retry; it now gets 15 s and logs a warning when it fails.
