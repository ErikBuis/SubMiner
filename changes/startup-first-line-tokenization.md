type: fixed
area: overlay

- Colored overlay subtitles appear sooner after startup on slower machines. The first subtitle line is tokenized once instead of up to four times in parallel, background subtitle prefetching waits until the on-screen line is done, and SubMiner no longer reconnects to mpv right after starting, which restarted the background prefetch and redid startup work.
