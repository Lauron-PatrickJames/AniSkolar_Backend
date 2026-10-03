const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const FseReport = require('../models/FseReport');
const { requireAdso } = require('../middleware/requireAdmin');

// FSE (Full Scholarship Equivalent) reports — AdSO only. The browser reads
// the registrar's .xls export and sends the parsed rows; the server
// validates them and recomputes each scholar's FSE.

const MAX_SCHOLARS = 10000;
const { CATEGORIES, TERMS } = FseReport;

const money = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null);

// Returns { report } or { error }.
function validateReport(body) {
  const academicYear = typeof body.academicYear === 'string' ? body.academicYear.trim() : '';
  if (!/^AY \d{4}–\d{4}$/.test(academicYear)) return { error: 'Choose the academic year.' };
  if (!TERMS.includes(body.term)) return { error: 'Choose the term.' };
  const population = Number(body.population);
  if (!Number.isFinite(population) || population < 1) return { error: 'Enter the student population for the term.' };
  if (!Array.isArray(body.scholarships) || body.scholarships.length === 0) return { error: 'The file has no scholarships to save.' };

  let count = 0;
  const scholarships = [];
  for (const s of body.scholarships) {
    if (!s || typeof s.code !== 'string' || !s.code.trim()) return { error: 'Every scholarship needs its code.' };
    if (!CATEGORIES.includes(s.category)) return { error: `Choose a category for scholarship ${s.code}.` };
    const scholars = [];
    for (const r of Array.isArray(s.scholars) ? s.scholars : []) {
      const matriculation = money(r.matriculation);
      const totalDiscount = money(r.totalDiscount);
      if (!r.studentId || matriculation === null || totalDiscount === null || matriculation === 0) {
        return { error: `Scholarship ${s.code} has a row without a student ID, matriculation or discount.` };
      }
      scholars.push({
        studentId: String(r.studentId).trim(),
        program: typeof r.program === 'string' ? r.program.trim() : undefined,
        matriculation,
        discount: money(r.discount) ?? 0,
        allowances: money(r.allowances) ?? 0,
        totalDiscount,
        fse: totalDiscount / matriculation,
      });
    }
    count += scholars.length;
    scholarships.push({
      code: s.code.trim(),
      name: typeof s.name === 'string' ? s.name.trim() : '',
      fundSource: typeof s.fundSource === 'string' ? s.fundSource.trim() : '',
      subcategory: typeof s.subcategory === 'string' ? s.subcategory.trim() : '',
      category: s.category,
      scholars,
    });
  }
  if (count > MAX_SCHOLARS) return { error: `A report can have at most ${MAX_SCHOLARS} scholars.` };

  const asOf = body.asOf ? new Date(body.asOf) : undefined;
  if (asOf && Number.isNaN(asOf.getTime())) return { error: 'Invalid "as of" date.' };

  return {
    report: {
      academicYear, term: body.term, population: Math.round(population), asOf,
      fileName: typeof body.fileName === 'string' ? body.fileName.slice(0, 200) : undefined,
      scholarships,
    },
  };
}

const toId = id => { try { return new ObjectId(id); } catch { return null; } };

// GET /api/fse — saved semesters, newest first (without the scholar rows).
router.get('/', requireAdso, async (req, res) => {
  try {
    const reports = await FseReport.find({}).select('-scholarships.scholars').sort({ academicYear: -1, term: -1 }).lean();
    res.json({ reports: reports.map(r => ({ ...r, id: String(r._id) })) });
  } catch (err) {
    console.error('List FSE reports error:', err);
    res.status(500).json({ error: 'Failed to load FSE reports.' });
  }
});

// GET /api/fse/:id — one semester in full.
router.get('/:id', requireAdso, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid report id.' });
  try {
    const report = await FseReport.findById(id).lean();
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    res.json({ report: { ...report, id: String(report._id) } });
  } catch (err) {
    console.error('Get FSE report error:', err);
    res.status(500).json({ error: 'Failed to load the FSE report.' });
  }
});

// PUT /api/fse — saves a semester; replaces an existing report for the
// same academic year and term.
router.put('/', requireAdso, async (req, res) => {
  const { report, error } = validateReport(req.body || {});
  if (error) return res.status(400).json({ error });
  try {
    const saved = await FseReport.findOneAndUpdate(
      { academicYear: report.academicYear, term: report.term },
      { $set: { ...report, updatedBy: req.adminUser.email } },
      { upsert: true, returnDocument: 'after', runValidators: true, setDefaultsOnInsert: true }
    ).lean();
    res.json({ report: { ...saved, id: String(saved._id) } });
  } catch (err) {
    console.error('Save FSE report error:', err);
    res.status(500).json({ error: 'Failed to save the FSE report.' });
  }
});

// DELETE /api/fse/:id
router.delete('/:id', requireAdso, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid report id.' });
  try {
    const deleted = await FseReport.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: 'Report not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete FSE report error:', err);
    res.status(500).json({ error: 'Failed to delete the FSE report.' });
  }
});

module.exports = router;
module.exports.validateReport = validateReport;
