type: fixed
area: overlay

- Fixed SubMiner crashing on recent Windows 11 builds as soon as it attached to mpv. The search for the mpv window no longer goes through a native callback, which could overflow the stack there.
