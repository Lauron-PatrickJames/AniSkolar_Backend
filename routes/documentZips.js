const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { requireAdmin } = require('../middleware/requireAdmin');
const Application = require('../models/Application');
const Renewal = require('../models/Renewal');
const RenewalPeriod = require('../models/RenewalPeriod');
const Student = require('../models/Student');
const { officeFilter, scopedOffice } = require('../utils/officeScope');
const { findScholarship } = require('../data/scholarships');
const { openFile } = require('../utils/gridfs');

// "Download all" for the office: a scholar's files as one .zip, streamed
// as it's built (nothing is stored). Same access as single files: an
// office sees its own applications and renewals, the AdSO sees all.
//   GET /api/documents/application/:id      one application's documents
//   GET /api/documents/student/:studentNumber  every application and renewal of a student
//   GET /api/documents/renewal-period/:id   every renewal's documents for a period
// Folders: "<name>-documents / <reference or renewal> / <document>.<ext>"
// (one application: its files directly in "<name>-documents").

const MAX_FILES = 3000;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };

const clean = s => String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';
const nameOfStudent = s => clean(s?.name ? `${s.name} ${s.studentNumber}` : s?.studentNumber);
// "REYES, MARIA S." -> "Reyes, Maria S-documents" (the student number when
// there's no name).
function docsFolder(s) {
  const name = String(s?.name || '').trim().toLowerCase().replace(/(^|[\s,(-])\p{L}/gu, m => m.toUpperCase()).replace(/\.+$/, '');
  return `${clean(name || s?.studentNumber)}-documents`;
}

function canSeeRenewal(adminUser, scholarshipId) {
  const office = scopedOffice(adminUser);
  return !office || findScholarship(scholarshipId)?.office === office;
}

// Entries for one application or renewal, under `folder`.
function entriesFor(folder, documents) {
  return (documents || []).map(d => {
    const ext = EXT[d.mimetype] || (d.filename?.match(/\.([a-z0-9]{2,4})$/i)?.[1] ?? 'jpg').toLowerCase();
    return { fileId: d.fileId, path: `${folder}/${clean(d.docType || d.filename?.replace(/\.[^.]+$/, ''))}.${ext}` };
  });
}

const appFolder = a => clean(`${a.referenceCode || String(a._id).slice(-6)} ${a.scholarshipName || findScholarship(a.scholarshipId)?.name || ''}`);
const renewalFolder = r => clean(`Renewal ${r.term} ${r.academicYear}-${r.academicYear + 1} ${r.scholarshipName || ''}`);

// Streams the zip. Paths are made unique ("Grades (2).jpg"); a file that
// can't be read becomes a note in MISSING FILES.txt instead of failing all.
async function sendZip(res, zipName, entries) {
  if (!entries.length) return res.status(404).json({ error: 'There are no files to download.' });
  if (entries.length > MAX_FILES) return res.status(400).json({ error: `That's more than ${MAX_FILES} files; download a smaller group.` });
  const archiver = require('archiver');
  const zip = archiver('zip', { zlib: { level: 1 } }); // photos and PDFs barely compress
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${zipName.replace(/"/g, '')}.zip"`);
  res.set('Cache-Control', 'private, no-store');
  zip.on('warning', err => console.warn('Zip warning:', err.message));
  zip.on('error', err => { console.error('Zip failed:', err); res.destroy(err); });
  zip.pipe(res);
  const used = new Map();
  const missing = [];
  for (const e of entries) {
    let path = e.path;
    const n = used.get(path.toLowerCase()) ?? 0;
    used.set(e.path.toLowerCase(), n + 1);
    if (n) path = path.replace(/(\.[^.\/]+)$/, ` (${n + 1})$1`);
    try {
      const file = await openFile(e.fileId);
      if (!file) { missing.push(path); continue; }
      // One at a time: wait for this file to be written before the next.
      await new Promise((resolve, reject) => {
        file.stream.on('error', reject);
        zip.append(file.stream, { name: path });
        zip.once('entry', resolve);
      });
    } catch (err) {
      console.error(`Zip: ${e.fileId} left out:`, err.message);
      missing.push(path);
    }
  }
  if (missing.length) zip.append(`These files couldn't be read:\r\n${missing.join('\r\n')}\r\n`, { name: 'MISSING FILES.txt' });
  await zip.finalize();
}

router.get('/application/:id', requireAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid application.' });
    const app = await Application.findOne({ _id: req.params.id, ...officeFilter(req.adminUser) }).select('studentNumber referenceCode scholarshipId scholarshipName documents').lean();
    if (!app) return res.status(404).json({ error: 'Application not found.' });
    const student = await Student.findOne({ studentNumber: app.studentNumber }).select('studentNumber name').lean();
    const folder = docsFolder(student ?? app);
    await sendZip(res, folder, entriesFor(folder, app.documents));
  } catch (err) {
    console.error('Application zip error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to prepare the download.' });
  }
});

router.get('/student/:studentNumber', requireAdmin, async (req, res) => {
  try {
    const studentNumber = String(req.params.studentNumber).trim();
    const [student, apps, renewals] = await Promise.all([
      Student.findOne({ studentNumber }).select('studentNumber name').lean(),
      Application.find({ studentNumber, ...officeFilter(req.adminUser) }).select('referenceCode scholarshipId scholarshipName documents createdAt').sort({ createdAt: 1 }).lean(),
      Renewal.find({ studentNumber }).select('scholarshipId scholarshipName academicYear term documents createdAt').sort({ createdAt: 1 }).lean(),
    ]);
    const visibleRenewals = renewals.filter(r => canSeeRenewal(req.adminUser, r.scholarshipId));
    if (!apps.length && !visibleRenewals.length) return res.status(404).json({ error: 'No applications or renewals for this student.' });
    const folder = docsFolder(student ?? { studentNumber });
    const entries = [
      ...apps.flatMap(a => entriesFor(`${folder}/${appFolder(a)}`, a.documents)),
      ...visibleRenewals.flatMap(r => entriesFor(`${folder}/${renewalFolder(r)}`, r.documents)),
    ];
    await sendZip(res, folder, entries);
  } catch (err) {
    console.error('Student zip error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to prepare the download.' });
  }
});

router.get('/renewal-period/:id', requireAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid period.' });
    const period = await RenewalPeriod.findById(req.params.id).lean();
    if (!period || !canSeeRenewal(req.adminUser, period.scholarshipId)) return res.status(404).json({ error: 'Renewal period not found.' });
    const renewals = await Renewal.find({ periodId: period._id, 'documents.0': { $exists: true } }).select('studentNumber documents').lean();
    const students = await Student.find({ studentNumber: { $in: renewals.map(r => r.studentNumber) } }).select('studentNumber name').lean();
    const byNumber = new Map(students.map(s => [s.studentNumber, s]));
    // "<name>-documents" per scholar; the student number is added when two
    // scholars share a name.
    const folderOf = r => docsFolder(byNumber.get(r.studentNumber) ?? r);
    const counts = new Map();
    renewals.forEach(r => counts.set(folderOf(r), (counts.get(folderOf(r)) ?? 0) + 1));
    const entries = renewals
      .sort((a, b) => nameOfStudent(byNumber.get(a.studentNumber) ?? a).localeCompare(nameOfStudent(byNumber.get(b.studentNumber) ?? b)))
      .flatMap(r => entriesFor(counts.get(folderOf(r)) > 1 ? folderOf(r).replace(/-documents$/, ` ${r.studentNumber}-documents`) : folderOf(r), r.documents));
    const name = findScholarship(period.scholarshipId)?.name ?? period.scholarshipId;
    await sendZip(res, clean(`Renewals ${name} ${period.term} ${period.academicYear}-${period.academicYear + 1}`), entries);
  } catch (err) {
    console.error('Renewal period zip error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to prepare the download.' });
  }
});

module.exports = router;
