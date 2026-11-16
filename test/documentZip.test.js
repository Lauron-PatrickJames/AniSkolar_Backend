// The zip library (npm test): builds a zip the way routes/documentZips.js
// does, so an archiver upgrade that changes its API fails here first.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('stream');
const { ZipArchive } = require('archiver');

test('a document folder zip is built from streamed files and a note', async () => {
  const zip = new ZipArchive({ zlib: { level: 1 } });
  const out = new PassThrough();
  const chunks = [];
  out.on('data', c => chunks.push(c));
  const done = new Promise(resolve => out.on('end', resolve));
  zip.pipe(out);
  zip.append(Readable.from([Buffer.from('fake grades')]), { name: 'Grades.jpg' });
  zip.append('These files couldn\'t be read:\r\nID.jpg\r\n', { name: 'MISSING FILES.txt' });
  await zip.finalize();
  await done;
  const bytes = Buffer.concat(chunks);
  // A zip starts with "PK\x03\x04" and names its entries in plain text.
  assert.equal(bytes.subarray(0, 4).toString('binary'), 'PK\x03\x04');
  assert.ok(bytes.includes('Grades.jpg'));
  assert.ok(bytes.includes('MISSING FILES.txt'));
});
