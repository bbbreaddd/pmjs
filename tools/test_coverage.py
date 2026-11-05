import json
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET


def coverage(tests, results):
    native = {
        test['name'] for test in tests
        if any(prop['name'] == 'LABELS' and 'native' in prop['value']
               for prop in test.get('properties', []))
    }
    outcomes = {}
    if results is not None:
        for case in results.iter('testcase'):
            if case.attrib['name'] not in native:
                continue
            if case.find('failure') is not None or case.find('error') is not None:
                status = 'failed'
            elif case.find('skipped') is not None or case.get('status') == 'notrun':
                status = 'skipped'
            else:
                status = 'passed'
            outcomes[case.attrib['name']] = status
    lines = ['## Native test coverage', '',
             f'Configured native CTest cases: {len(native)}. '
             f'Passed: {list(outcomes.values()).count("passed")}. '
             f'Failed: {list(outcomes.values()).count("failed")}. '
             f'Skipped: {list(outcomes.values()).count("skipped")}. '
             f'Not selected or not reached: {len(native - outcomes.keys())}.', '',
             'Preset: dev (FreeType, software GLES). Skia65 backend tests are not configured; '
             'this run does not establish Skia65 or target-device GPU compatibility.', '']
    if results is None:
        lines.extend(['No CTest result file was produced; no native passes are recorded.', ''])
    for title, names in [
        ('Failed', [name for name, status in outcomes.items() if status == 'failed']),
        ('Skipped by CTest', [name for name, status in outcomes.items() if status == 'skipped']),
        ('Not selected or not reached', native - outcomes.keys()),
    ]:
        if names:
            lines.extend([f'<details><summary>{title} ({len(names)})</summary>', ''])
            lines.extend(f'- `{name}`' for name in sorted(names))
            lines.extend(['', '</details>', ''])
    return '\n'.join(lines)


def main():
    build = Path(sys.argv[1])
    inventory = subprocess.run(
        ['ctest', '--test-dir', str(build), '--show-only=json-v1'],
        check=True, capture_output=True, text=True)
    results = build / 'native-tests.xml'
    print(coverage(json.loads(inventory.stdout)['tests'],
                   ET.parse(results).getroot() if results.exists() else None))


if __name__ == '__main__':
    main()
