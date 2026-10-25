type: added
area: dictionary

- Added a bundled Hachidori dictionary backend as an alternative to the default Yomitan backend. Select it with `dictionaryBackend` and restart SubMiner. Each backend keeps its own dictionaries and settings, and switching back does not repeat first-run setup.
- Hachidori works with subtitle scanning, popup controls, frequency highlighting, character dictionaries, Anki media enrichment, and stats dashboard mining.
- First-run setup fills in Hachidori's first Anki template from SubMiner's deck, tags, and field mappings. It can also link an external Hachidori host (app, browser, or Docker container) while Anki mining stays in SubMiner. Character dictionaries reach a linked host with Hachidori 0.2.3 or later.
- The tray and dictionary-settings shortcut open settings for the selected backend. `--hachidori` and `--yomitan` open a specific one.
