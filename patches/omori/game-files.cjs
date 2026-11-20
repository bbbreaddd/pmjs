'use strict';
const crypto = require('node:crypto');
const path = require('node:path').posix;
const { TextDecoder } = require('node:util');
const header = Buffer.from('5250474d560000000003010000000000', 'hex');
const extensions = { '.kel': '.json', '.aubrey': '.json', '.hero': '.yaml', '.pluto': '.yaml',
  '.omori': '.js', '.rpgmvp': '.png', '.rpgmvo': '.ogg', '.rpgmvm': '.m4a' };
function normalize(name) { return path.normalize(String(name).replace(/\\/g, '/').replace(/^\/game\//, '')); }
function canonical(name) { return normalize(name).replace(/\.[^/.]+$/, extension => extensions[extension.toLowerCase()] || extension); }
function createGameFiles({ native, read, readAsync = async name => read(name), createLayer, configuration = {} }) {
  let steamKey, assetKey;
  function key() {
    if (!steamKey) {
      const filename = configuration.omori?.encryptionKeyFile;
      steamKey = filename ? read(filename).toString('utf8').trim() :
        read('js/main.js').toString('utf8').match(/\bkey\s*=\s*['"]([a-f0-9]{32})['"]/i)?.[1];
      if (!steamKey || !/^[a-f0-9]{32}$/i.test(steamKey)) throw new Error('OMORI file decryption requires a valid game key');
    }
    return steamKey;
  }
  function plainText(bytes, name) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (/\.json$/i.test(name)) JSON.parse(text);
      return !text.includes('\0');
    } catch { return false; }
  }
  function decode(name, input) {
    const bytes = Buffer.from(input), logical = canonical(name);
    if (bytes.subarray(0, 16).equals(header)) {
      if (!assetKey) {
        const system = JSON.parse(get('data/System.json').toString('utf8'));
        if (!/^[a-f0-9]{32}$/i.test(system.encryptionKey)) throw new Error('invalid OMORI image encryption key');
        assetKey = Buffer.from(system.encryptionKey, 'hex');
      }
      const body = Buffer.from(bytes.subarray(16));
      for (let i = 0; i < 16; i++) body[i] ^= assetKey[i];
      return body;
    }
    if (/\.(json|yaml|js)$/i.test(logical) && !plainText(bytes, logical)) {
      if (bytes.length < 16) throw new Error('truncated OMORI game file: ' + logical);
      const cipher = crypto.createDecipheriv('aes-256-ctr', key(), bytes.subarray(0, 16));
      const body = Buffer.concat([cipher.update(bytes.subarray(16)), cipher.final()]);
      if (!plainText(body, logical)) throw new Error('cannot decode OMORI game file: ' + logical);
      return body;
    }
    return bytes;
  }
  function candidates(name) {
    const logical = canonical(name);
    const suffix = path.extname(logical).toLowerCase();
    const variants = Object.keys(extensions).filter(extension => extensions[extension] === suffix)
      .map(extension => logical.slice(0, -suffix.length) + (/^\.(kel|aubrey|hero|pluto|omori)$/.test(extension) ? extension.toUpperCase() : extension));
    return [logical, ...variants];
  }
  function source(name) {
    return candidates(name).find(candidate => native.fs.exists(candidate));
  }
  function remove(name) {
    for (const candidate of candidates(name)) {
      if (native.fs.exists(candidate)) native.fs.remove(candidate);
    }
  }
  function rename(from, to) {
    const input = source(from) || canonical(from), output = source(to) || canonical(to);
    native.fs.rename(input, output);
    const fold = name => canonical(name).replace(/[A-Z]/g, letter => letter.toLowerCase());
    if (fold(from) !== fold(to)) remove(from);
  }
  function get(name) {
    const file = source(name);
    if (!file) throw new Error('OMORI game file is missing: ' + canonical(name));
    return decode(file, read(file));
  }
  async function getAsync(name) {
    const file = source(name);
    if (!file) return null;
    const bytes = await readAsync(file);
    return bytes === null ? null : decode(file, bytes);
  }
  function layer(name) {
    const output = createLayer(name), files = new Map();
    return {
      write(name, input) {
        const logical = canonical(name), bytes = decode(name, input);
        files.set(logical, { path: logical, bytes });
        output.write(logical, bytes);
      },
      finish() { return { ...output.finish(), files: [...files.values()] }; },
      dispose() { output.dispose(); }
    };
  }
  return { read: get, readAsync: getAsync, resolve: source, remove, rename, getEncryptionKey: key,
    exists: name => !!source(name), createLayer: layer,
    decodeText: bytes => decode('text.yaml', bytes), decodeMedia: bytes => decode('image.png', bytes) };
}
module.exports = { createGameFiles };
