#!/usr/bin/env python3
"""Subset licensed DejaVu Sans for shaping tests; requires fontTools."""
import hashlib
import pathlib
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

source = pathlib.Path(sys.argv[1])
if hashlib.sha256(source.read_bytes()).hexdigest() != \
        'ae7b7855e115a5966d8b1b3f80f254ccc117ec86f9965e202ee2940453837280':
    raise SystemExit('Expected the pinned DejaVu Sans 2.37 source font')
font = TTFont(source, recalcTimestamp=False)
options = subset.Options()
options.name_IDs = ['*']
options.name_legacy = True
options.name_languages = ['*']
options.notdef_outline = True
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=list(range(0x20, 0x7F)) +
    [0xE9, 0x301, 0x323, 0x2665, 0x2764] + list(range(0x600, 0x700)))
subsetter.subset(font)
# A synthetic alternate verifies selectors affect shaping without OS emoji fallback.
variation = CmapSubtable.newSubtable(14)
variation.platformID = 0
variation.platEncID = 5
variation.language = 0
variation.cmap = {}
variation.uvsDict = {0xFE0F: [(0x2764, font.getBestCmap()[0x2665])]}
font['cmap'].tables.append(variation)
for record in font['name'].names:
    if record.nameID in [1, 2, 3, 4, 6, 16, 17]:
        name = 'Regular' if record.nameID in [2, 17] else 'PMJS Text Test'
        record.string = name.encode(record.getEncoding())
output = pathlib.Path(__file__).resolve().parents[2] / 'test/assets/text-shaping.ttf'
font.save(output)
