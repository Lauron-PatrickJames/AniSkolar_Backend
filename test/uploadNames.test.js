// Uploaded file names (npm test): sent as UTF-8 by browsers, kept as typed
// ("Attendance – Assembly.pdf" used to come out as "Attendance â€“ ...").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { attendanceSheetUpload } = require('../middleware/uploadConfig');

test('a name with a dash and ñ survives the upload', async () => {
  const a = express();
  a.post('/up', attendanceSheetUpload, (req, res) => res.json({ names: req.files.map(f => f.originalname) }));
  const server = a.listen(0);
  try {
    const form = new FormData();
    form.append('sheets', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'Attendance – Assembly Señor.pdf');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/up`, { method: 'POST', body: form });
    assert.deepEqual((await res.json()).names, ['Attendance – Assembly Señor.pdf']);
  } finally {
    server.close();
  }
});
