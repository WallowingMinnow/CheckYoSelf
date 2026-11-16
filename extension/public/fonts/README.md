# Bundled fonts

Shipped inside the extension so the popup never fetches fonts from the internet.
Downloaded from Google's official repository, https://github.com/google/fonts (2026-11-15).

| File | Font | License |
|---|---|---|
| `Anton-Regular.ttf` | Anton (headlines, wordmark) | SIL Open Font License 1.1 (`Anton-OFL.txt`) |
| `PermanentMarker-Regular.ttf` | Permanent Marker (marker accents) | Apache License 2.0 (`PermanentMarker-LICENSE.txt`) |

Loaded by `public/fonts.css` (popup and dashboard pages only). The Instagram
panel can't use them (web fonts don't load inside its Shadow DOM), so it falls
back to Impact / Arial Black.
