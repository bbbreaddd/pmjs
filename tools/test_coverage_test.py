import os
from pathlib import Path
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET

from test_coverage import coverage


class CoverageTest(unittest.TestCase):
    def test_reports_actual_outcomes_and_omitted_native_tests(self):
        tests = [
            {'name': name, 'properties': [{'name': 'LABELS', 'value': labels}]}
            for name, labels in [('passed', ['native', 'smoke']),
                                 ('failed', ['native']), ('error', ['native']),
                                 ('skipped', ['native']), ('notrun', ['native']),
                                 ('omitted', ['native']), ('js-only', ['js'])]
        ]
        results = ET.fromstring('''<testsuite>
          <testcase name="passed"/>
          <testcase name="failed"><failure/></testcase>
          <testcase name="error"><error/></testcase>
          <testcase name="skipped"><skipped/></testcase>
          <testcase name="notrun" status="notrun"/>
          <testcase name="js-only"/>
        </testsuite>''')
        report = coverage(tests, results)
        self.assertIn('Configured native CTest cases: 6. Passed: 1. Failed: 2. Skipped: 2.', report)
        self.assertIn('Not selected or not reached: 1.', report)
        self.assertIn('- `omitted`', report)
        self.assertNotIn('js-only', report)

    def test_missing_results_does_not_claim_passes(self):
        tests = [{'name': 'native-test',
                  'properties': [{'name': 'LABELS', 'value': ['native']}]}]
        report = coverage(tests, None)
        self.assertIn('Passed: 0.', report)
        self.assertIn('No CTest result file was produced', report)
        self.assertIn('- `native-test`', report)


class CoverageIntegrationTest(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('PMJS_TEST_BUILD_DIR'), 'requires a completed native CTest run')
    def test_reads_junit_from_configured_build_directory(self):
        build = Path(os.environ['PMJS_TEST_BUILD_DIR']).resolve()
        results = ET.parse(build / 'native-tests.xml').getroot()
        cases = {case.attrib['name']: case for case in results.iter('testcase')}
        self.assertIn('native-vfs', cases)
        self.assertIsNone(cases['native-vfs'].find('failure'))
        report = subprocess.run(
            [sys.executable, str(Path(__file__).with_name('test_coverage.py')), str(build)],
            check=True, capture_output=True, text=True).stdout
        self.assertIn('Native test coverage', report)
        self.assertNotIn('No CTest result file was produced', report)
        self.assertNotIn('Passed: 0.', report)
        self.assertNotIn('- `native-vfs`', report)


if __name__ == '__main__':
    unittest.main()
