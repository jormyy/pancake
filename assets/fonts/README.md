# Web font assets

Outfit retains the complete 500, 600, and 700 faces from `@expo-google-fonts/outfit` 0.4.3. WOFF2 changes the encoding, not outlines or character coverage. The original font license is included.

Metro substitutes these assets only for web builds. Native builds keep the package's original TTF files and complete icon font.

Metro scans source before it first substitutes the web icon font or glyph map. Successful validation applies to that configuration instance. Loading the configuration alone does not scan source.

Material Icons is Copyright 2018 Google, Inc. under the included Apache 2.0 license. MaterialIcons retains the names in `assets/fonts/MaterialIcons.glyphs.json`. The generator reads MaterialIcons elements and typed icon props, defaults, and lookup tables in app, components, constants, hooks, lib, and contexts. It ignores unrelated cache keys and style values. Current icon choices use literal names, typed unions, and literal lookup tables. Metro rejects a referenced name when its codepoint differs from the shipped map. Add new icon choices as literals; do not construct icon names from user input or strings.

Regenerate after changing icon names or upstream fonts:

```sh
python3 -m venv .venv
.venv/bin/pip install 'fonttools[woff]==4.60.1'
.venv/bin/python assets/fonts/generate.py
```

The generator requires installed npm dependencies. Commit the resulting font files and glyph map. Compare glyph outlines and Outfit character maps with their upstream fonts. Run the font and boot contract tests after regeneration.
