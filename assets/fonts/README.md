# Web font assets

Outfit retains the complete 500, 600, and 700 faces from `@expo-google-fonts/outfit` 0.4.3. WOFF2 changes the encoding, not outlines or character coverage. The original font license is included.

Metro substitutes these assets only for web builds. Native builds keep the package's original TTF files and complete icon font.

Material Icons is Copyright 2018 Google, Inc. under the included Apache 2.0 license. MaterialIcons retains 88 names found in application source, including labels that also match icon names. The generator scans every quoted word in app, components, constants, hooks, lib, and contexts. Current icon choices use literal names, typed unions, and literal lookup tables. Metro rejects a referenced name when its codepoint differs from the shipped map. Add new icon choices as literals; do not construct icon names from user input or strings.

Regenerate after changing icon names or upstream fonts:

```sh
python3 -m venv .venv
.venv/bin/pip install 'fonttools[woff]==4.60.1'
.venv/bin/python assets/fonts/generate.py
```

The generator requires installed npm dependencies. Commit the resulting font files and glyph map. Verify every shipped icon in the browser atlas probe. Compare glyph outlines and Outfit character maps with their upstream fonts.
