import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

src = sys.argv[1]
print({a.axisTag: (a.minValue, a.defaultValue, a.maxValue) for a in TTFont(src)["fvar"].axes})
cuts = {"sans": {"MONO": 0, "CRSV": 0, "slnt": 0}, "mono": {"MONO": 1, "CASL": 0, "CRSV": 0, "slnt": 0}}
for name, pins in cuts.items():
    font = instancer.instantiateVariableFont(TTFont(src), pins)
    font.flavor = "woff2"
    out = f"web/vendor/fonts/recursive-{name}-latin.woff2"
    font.save(out)
    print(out, {a.axisTag: (a.minValue, a.maxValue) for a in font["fvar"].axes})
