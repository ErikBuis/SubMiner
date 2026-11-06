type: fixed
area: anki

- The card review no longer gives up after 5 minutes. Before, a review left open that long silently wrote the card with the original timing while the dialog stayed open, and pressing Export afterwards only closed it, so every edit was lost. The review now waits as long as it takes. If the review window's renderer crashes, the review ends right away with the original timing instead of blocking mining.
