'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const root = path.resolve(__dirname, '..');

test('source provenance inventory checks pass', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'tools/check-provenance.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Provenance inventory checks passed/);
});

test('inventory checks reject invalid classifications, stale entries and missing notices', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pmjs-provenance-'));
  try {
    for (const directory of ['tools', 'third_party', 'runner', 'js/pmjs-plugins', 'test/assets']) {
      fs.mkdirSync(path.join(temporary, directory), { recursive: true });
    }
    assert.equal(spawnSync('git', ['init', '-q', temporary]).status, 0);
    fs.copyFileSync(path.join(root, 'tools/check-provenance.cjs'), path.join(temporary, 'tools/check-provenance.cjs'));
    fs.writeFileSync(path.join(temporary, 'LICENSE'), 'Synthetic notice');
    fs.writeFileSync(path.join(temporary, 'runner/ordinary.cjs'), "'use strict';\n");
    const defaults = { origin: 'original', source: 'PMJS', license: 'MIT', notice: 'LICENSE' };
    const files = {};
    const checker = path.join(temporary, 'tools/check-provenance.cjs');
    function check() {
      fs.writeFileSync(path.join(temporary, 'third_party/provenance.json'), JSON.stringify({ defaults, files }));
      return spawnSync(process.execPath, [checker], { encoding: 'utf8' });
    }
    function rejected(pattern) {
      const result = check();
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, pattern);
    }
    assert.equal(check().status, 0);
    files['runner/ordinary.cjs'] = { ...defaults, origin: 'unclassified' };
    rejected(/Invalid origin: runner\/ordinary.cjs/);
    files['runner/ordinary.cjs'] = { ...defaults, notice: 'missing.LICENSE' };
    rejected(/Missing notice: runner\/ordinary.cjs/);
    files['runner/ordinary.cjs'] = { ...defaults, source: '' };
    rejected(/Incomplete provenance: runner\/ordinary.cjs/);
    files['runner/ordinary.cjs'] = { ...defaults, origin: 'permissive' };
    rejected(/Missing revision: runner\/ordinary.cjs/);
    delete files['runner/ordinary.cjs'];
    files['runner/missing.cjs'] = { origin: 'original' };
    rejected(/Stale inventory entry: runner\/missing.cjs/);
    delete files['runner/missing.cjs'];
    fs.writeFileSync(path.join(temporary, 'test/assets/sample.ttf'), 'Synthetic font fixture');
    fs.writeFileSync(path.join(temporary, 'js/pmjs-plugins/sample.js'), '// synthetic fixture\n');
    rejected(/Unclassified file: js\/pmjs-plugins\/sample.js/);
    files['js/pmjs-plugins/sample.js'] = { origin: 'compatibility', source: 'PMJS', license: 'MIT', notice: 'LICENSE' };
    assert.equal(check().status, 0);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
