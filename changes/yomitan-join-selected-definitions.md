type: added
area: yomitan

- Yomitan can join meanings selected in the popup onto one line for `{popup-selection-text}`: turn on "Join selected definitions on one line" in Yomitan's Anki settings. Separators between meanings and synonyms are configurable; the default output is unchanged.
- Adding a card with Yomitan's + button without selecting anything no longer counts as an empty selection, so a custom Anki field template that falls back to the definition when nothing is selected (`hasMedia "popupSelectionText"`) now fills the field. `{popup-selection-text}` still writes nothing in that case.
