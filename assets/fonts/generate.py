import json
import subprocess
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parents[2]
fonts = root / 'assets/fonts'
fonts.mkdir(parents=True, exist_ok=True)
vendor = root / 'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons'
selected = json.loads(subprocess.check_output(['node', str(fonts / 'collect-icons.js')], cwd=root))
(fonts / 'MaterialIcons.glyphs.json').write_text(json.dumps(selected, indent=2) + '\n')
font = TTFont(vendor / 'Fonts/MaterialIcons.ttf', recalcTimestamp=False)
options = subset.Options()
options.flavor = 'woff2'
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=selected.values())
subsetter.subset(font)
font.flavor = 'woff2'
font.save(fonts / 'MaterialIcons.woff2')
for family in ['500Medium', '600SemiBold', '700Bold']:
    name = 'Outfit_' + family
    source = root / ('node_modules/@expo-google-fonts/outfit/' + family + '/' + name + '.ttf')
    font = TTFont(source, recalcTimestamp=False)
    font.flavor = 'woff2'
    font.save(fonts / (name + '.woff2'))
print(json.dumps({'glyphs': len(selected), 'files': {file.name: file.stat().st_size for file in fonts.iterdir()}}, indent=2))
