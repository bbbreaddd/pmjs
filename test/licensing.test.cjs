'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { temporaryDirectory } = require('./helpers/temp.cjs');
const root = path.resolve(__dirname, '..');

test('inventory checks reject invalid classifications, stale entries and missing notices', () => {
  const temporary = temporaryDirectory('pmjs-provenance-');
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

test('provenance discovery checks patch files without explicit inventory entries', () => {
  const temporary = temporaryDirectory('pmjs-patch-provenance-');
  for (const directory of ['tools', 'third_party', 'patches/isat']) {
    fs.mkdirSync(path.join(temporary, directory), { recursive: true });
  }
  assert.equal(spawnSync('git', ['init', '-q', temporary]).status, 0);
  fs.copyFileSync(path.join(root, 'tools/check-provenance.cjs'), path.join(temporary, 'tools/check-provenance.cjs'));
  // Isolate discovery: the checker and its metadata are not inventoried inputs.
  fs.writeFileSync(path.join(temporary, '.gitignore'), '/tools/\n/third_party/provenance.json\n');
  fs.writeFileSync(path.join(temporary, 'third_party/provenance.json'), JSON.stringify({
    defaults: { origin: 'original', source: 'PMJS', license: 'MIT', notice: 'LICENSE' }, files: {}
  }));
  const checker = path.join(temporary, 'tools/check-provenance.cjs');
  const check = () => spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(check().status, 0);
  fs.writeFileSync(path.join(temporary, 'patches/isat/sample.js'), '// synthetic patch\n');
  for (const tracked of [false, true]) {
    if (tracked) assert.equal(spawnSync('git', ['-C', temporary, 'add', 'patches']).status, 0);
    const result = check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing notice: patches\/isat\/sample.js/);
  }
  fs.writeFileSync(path.join(temporary, 'LICENSE'), 'Synthetic notice');
  assert.equal(check().status, 0);
});
