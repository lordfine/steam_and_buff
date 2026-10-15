// Build an allowlisted, deterministic MV3 package with Node built-ins only.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
const files = ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'popup.css',
  'dashboard.html', 'dashboard.js', 'dashboard.css', 'LICENSE'];
function walk(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const name = dir + '/' + entry.name;
    if (entry.isDirectory()) walk(name);
    else if (entry.isFile()) files.push(name);
  }
}
['lib', 'ui', 'icons'].forEach(walk);
files.sort();
const out = path.join(root, 'dist', 'extension');
const stage = path.join(out, 'skinledger-' + manifest.version);
fs.mkdirSync(stage, { recursive: true });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
const local = [], central = [];
let offset = 0;
for (const file of files) {
  const bytes = fs.readFileSync(path.join(root, file));
  const target = path.join(stage, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target + '.tmp', bytes); fs.renameSync(target + '.tmp', target);
  const name = Buffer.from(file), compressed = zlib.deflateRawSync(bytes), crc = crc32(bytes);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
  local.push(header, name, compressed);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); header.copy(entry, 6, 4, 30);
  entry.writeUInt32LE(offset, 42); central.push(entry, name);
  offset += header.length + name.length + compressed.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const zip = path.join(out, 'SkinLedger-' + manifest.version + '-extension.zip');
fs.writeFileSync(zip + '.tmp', Buffer.concat([...local, directory, end])); fs.renameSync(zip + '.tmp', zip);
console.log('Extension: ' + zip + '\nUnpacked: ' + stage + '\nFiles: ' + files.length);
