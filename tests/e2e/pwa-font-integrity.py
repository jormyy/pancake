import json
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import RecordingPen

root = Path(__file__).resolve().parents[2]
fonts = root / 'assets/fonts'
original_icons = root / 'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/MaterialIcons.ttf'

def compare(before, after, codepoints):
    source = before.getGlyphSet()
    target = after.getGlyphSet()
    source_map = before.getBestCmap()
    target_map = after.getBestCmap()
    for codepoint in codepoints:
        assert codepoint in target_map, str(codepoint)
        expected = RecordingPen()
        actual = RecordingPen()
        source[source_map[codepoint]].draw(expected)
        target[target_map[codepoint]].draw(actual)
        assert expected.value == actual.value, str(codepoint)
        assert source[source_map[codepoint]].width == target[target_map[codepoint]].width, str(codepoint)

before = TTFont(original_icons)
after = TTFont(fonts / 'MaterialIcons.woff2')
points = set(json.loads((fonts / 'MaterialIcons.glyphs.json').read_text()).values())
compare(before, after, points)
negative = False
try:
    compare(before, after, set(before.getBestCmap()) - points)
except AssertionError:
    negative = True
assert negative
outfit = {}
for family in ['500Medium', '600SemiBold', '700Bold']:
    name = 'Outfit_' + family
    source = TTFont(root / ('node_modules/@expo-google-fonts/outfit/' + family + '/' + name + '.ttf'))
    target = TTFont(fonts / (name + '.woff2'))
    assert source.getBestCmap() == target.getBestCmap()
    compare(source, target, source.getBestCmap())
    outfit[name] = len(source.getBestCmap())
print(json.dumps({'materialGlyphs': len(points), 'outfitCharacterCoverage': outfit, 'outlinesAndWidthsEqual': True, 'missingGlyphControlFails': negative}))
