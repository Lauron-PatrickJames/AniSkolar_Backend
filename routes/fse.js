const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const FseReport = require('../models/FseReport');
const { requireAdso } = require('../middleware/requireAdmin');

// FSE (Full Scholarship Equivalent) reports — AdSO only. The browser reads
// the registrar's .xls export and sends the parsed rows; the server
// validates them and recomputes each scholar's FSE.

const MAX_SCHOLARS = 10000;
const { CATEGORIES, TERMS, SPECIAL_FUNDING } = FseReport;

const money = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null);

// The allowances by kind (meal, monthly, dorm, other, book): positive amounts only.
const ALLOWANCE_KINDS = ['meal', 'monthly', 'dorm', 'other', 'book'];
function allowanceDetail(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const k of ALLOWANCE_KINDS) { const v = money(raw[k]); if (v) out[k] = v; }
  return Object.keys(out).length ? out : undefined;
}

// Returns { report } or { error }.
function validateReport(body) {
  const academicYear = typeof body.academicYear === 'string' ? body.academicYear.trim() : '';
  if (!/^AY \d{4}–\d{4}$/.test(academicYear)) return { error: 'Choose the academic year.' };
  if (!TERMS.includes(body.term)) return { error: 'Choose the term.' };
  const population = Number(body.population);
  if (!Number.isFinite(population) || population < 1) return { error: 'Enter the student population for the term.' };
  if (!Array.isArray(body.scholarships) || body.scholarships.length === 0) return { error: 'The file has no scholarships to save.' };

  // Other grants for listed scholars (see the model): each student's amounts.
  const grants = [];
  for (const g of Array.isArray(body.grants) ? body.grants.slice(0, 20) : []) {
    const label = typeof g?.label === 'string' ? g.label.trim().slice(0, 60) : '';
    const amount = money(g?.amount);
    const studentIds = [...new Set((Array.isArray(g?.studentIds) ? g.studentIds : []).map(id => String(id).trim()).filter(Boolean))].slice(0, MAX_SCHOLARS);
    if (!label) return { error: 'Name each added grant (e.g. DOST).' };
    if (!amount) return { error: `Enter the amount per scholar for ${label}.` };
    if (!studentIds.length) return { error: `Enter the student numbers for ${label}.` };
    grants.push({ label, amount, studentIds });
  }
  const grantFor = new Map();   // studentId → total of its grants
  for (const g of grants) for (const id of g.studentIds) grantFor.set(id, (grantFor.get(id) || 0) + g.amount);
  const granted = new Set();     // applied once per student, to their first row

  let count = 0;
  const scholarships = [];
  for (const s of body.scholarships) {
    if (!s || typeof s.code !== 'string' || !s.code.trim()) return { error: 'Every scholarship needs its code.' };
    if (!CATEGORIES.includes(s.category)) return { error: `Choose a category for scholarship ${s.code}.` };
    if (s.category === 'special' && !SPECIAL_FUNDING.includes(s.specialFunding)) {
      return { error: `Choose how special program ${s.code} is funded.` };
    }
    // Allowances the AdSO entered for this scholarship, per scholar.
    const extra = allowanceDetail(s.allowances);
    const extraSum = extra ? Object.values(extra).reduce((n, v) => n + v, 0) : 0;
    const scholars = [];
    for (const r of Array.isArray(s.scholars) ? s.scholars : []) {
      const matriculation = money(r.matriculation);
      const totalDiscount = money(r.totalDiscount);
      if (!r.studentId || matriculation === null || totalDiscount === null || matriculation === 0) {
        return { error: `Scholarship ${s.code} has a row without a student ID, matriculation or discount.` };
      }
      // The file's own allowances (if any) plus the entered ones, plus the
      // student's other grants as other financial assistance.
      const detail = { ...(allowanceDetail(r.allowanceDetail) || {}) };
      if (extra) for (const [k, v] of Object.entries(extra)) detail[k] = Math.round(((detail[k] || 0) + v) * 100) / 100;
      const id = String(r.studentId).trim();
      const grant = !granted.has(id) ? grantFor.get(id) || 0 : 0;
      if (grant) { granted.add(id); detail.other = Math.round(((detail.other || 0) + grant) * 100) / 100; }
      // This scholar's own entered allowances.
      const entered = allowanceDetail(r.entered);
      const enteredSum = entered ? Object.values(entered).reduce((n, v) => n + v, 0) : 0;
      if (entered) for (const [k, v] of Object.entries(entered)) detail[k] = Math.round(((detail[k] || 0) + v) * 100) / 100;
      const total = Math.round((totalDiscount + extraSum + grant + enteredSum) * 100) / 100;
      scholars.push({
        studentId: String(r.studentId).trim(),
        program: typeof r.program === 'string' ? r.program.trim() : undefined,
        matriculation,
        discount: money(r.discount) ?? 0,
        allowances: Math.round(((money(r.allowances) ?? 0) + extraSum + grant + enteredSum) * 100) / 100,
        entered,
        allowanceDetail: Object.keys(detail).length ? detail : undefined,
        totalDiscount: total,
        fse: total / matriculation,
      });
    }
    // Scholars added by hand (see the model).
    let adjustment;
    if (s.adjustment) {
      const a = s.adjustment;
      const n = Number(a.scholars);
      const assessment = money(a.assessment);
      const discount = money(a.discount);
      const note = typeof a.note === 'string' ? a.note.trim().slice(0, 300) : '';
      if (!Number.isInteger(n) || n < 1 || n > MAX_SCHOLARS) return { error: `Scholarship ${s.code}: enter how many scholars to add.` };
      if (!assessment) return { error: `Scholarship ${s.code}: enter the added scholars' total assessment.` };
      if (discount === null) return { error: `Scholarship ${s.code}: enter the added scholars' total discount.` };
      if (!note) return { error: `Scholarship ${s.code}: say where the added scholars' numbers come from.` };
      adjustment = { scholars: n, assessment, discount, note };
      count += n;
    }
    count += scholars.length;
    scholarships.push({
      code: s.code.trim(),
      name: typeof s.name === 'string' ? s.name.trim() : '',
      fundSource: typeof s.fundSource === 'string' ? s.fundSource.trim() : '',
      subcategory: typeof s.subcategory === 'string' ? s.subcategory.trim() : '',
      category: s.category,
      specialFunding: s.category === 'special' ? s.specialFunding : undefined,
      allowances: extra,
      adjustment,
      scholars,
    });
  }
  if (count > MAX_SCHOLARS) return { error: `A report can have at most ${MAX_SCHOLARS} scholars.` };

  const spoon = body.spoonRecipients === undefined || body.spoonRecipients === '' || body.spoonRecipients === null ? undefined : Number(body.spoonRecipients);
  if (spoon !== undefined && (!Number.isInteger(spoon) || spoon < 0)) return { error: 'SPOON recipients must be a whole number.' };

  const asOf = body.asOf ? new Date(body.asOf) : undefined;
  if (asOf && Number.isNaN(asOf.getTime())) return { error: 'Invalid "as of" date.' };

  return {
    report: {
      academicYear, term: body.term, population: Math.round(population), spoonRecipients: spoon, asOf,
      grants: grants.length ? grants : undefined,
      fileName: typeof body.fileName === 'string' ? body.fileName.slice(0, 200) : undefined,
      scholarships,
    },
  };
}

const toId = id => { try { return new ObjectId(id); } catch { return null; } };

// GET /api/fse — the generated reports, newest first (without the scholar rows).
router.get('/', requireAdso, async (req, res) => {
  try {
    const reports = await FseReport.find({}).select('-scholarships.scholars').sort({ createdAt: -1 }).lean();
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

// POST /api/fse — generates a report: a new one every time (the AdSO
// generates FSE reports whenever they're needed; earlier ones are kept).
// PUT is kept for older clients and does the same.
const generate = async (req, res) => {
  const { report, error } = validateReport(req.body || {});
  if (error) return res.status(400).json({ error });
  try {
    const saved = (await FseReport.create({ ...report, updatedBy: req.adminUser.email })).toObject();
    res.status(201).json({ report: { ...saved, id: String(saved._id) } });
  } catch (err) {
    console.error('Save FSE report error:', err);
    res.status(500).json({ error: 'Failed to save the FSE report.' });
  }
};
router.post('/', requireAdso, generate);
router.put('/', requireAdso, generate);

// A saved scholarship's rows as they came from the registrar's file: the
// allowances the AdSO entered are taken back out, so new ones can be applied.
function fileRows(s, grantOf = new Map()) {
  const extra = allowanceDetail(s.allowances);
  const extraSum = extra ? Object.values(extra).reduce((n, v) => n + v, 0) : 0;
  const round = v => Math.round(v * 100) / 100;
  return (s.scholars || []).map(r => {
    const detail = { ...(r.allowanceDetail || {}) };
    if (extra) for (const [k, v] of Object.entries(extra)) { detail[k] = round((detail[k] || 0) - v); if (detail[k] <= 0) delete detail[k]; }
    // The other grants added to this row (its first one only).
    const grant = grantOf.get(r.studentId) || 0;
    grantOf.delete(r.studentId);
    if (grant) { detail.other = round((detail.other || 0) - grant); if (detail.other <= 0) delete detail.other; }
    const entered = allowanceDetail(r.entered) || {};
    const enteredSum = Object.values(entered).reduce((n, v) => n + v, 0);
    for (const [k, v] of Object.entries(entered)) { detail[k] = round((detail[k] || 0) - v); if (detail[k] <= 0) delete detail[k]; }
    return {
      studentId: r.studentId, program: r.program, matriculation: r.matriculation, discount: r.discount,
      allowances: Math.max(0, round((r.allowances || 0) - extraSum - grant - enteredSum)),
      allowanceDetail: Object.keys(detail).length ? detail : undefined,
      totalDiscount: round(r.totalDiscount - extraSum - grant - enteredSum),
    };
  });
}

// The edited report: the term details and, per scholarship, its category,
// funding and allowances, or leaving it out (not listed). The registrar's
// rows and amounts stay as they were uploaded. Returns { report } or { error }.
function editReport(saved, body) {
  const edits = new Map((Array.isArray(body.scholarships) ? body.scholarships : [])
    .filter(e => e && typeof e.code === 'string').map(e => [e.code.trim(), e]));
  // The saved grants per student, to take back out of their rows (in the
  // saved order, so each comes out of the row it went into).
  const grantOf = new Map();
  for (const g of saved.grants || []) for (const id of g.studentIds || []) grantOf.set(id, (grantOf.get(id) || 0) + g.amount);
  const rows = (saved.scholarships || []).map(s => ({ s, scholars: fileRows(s, grantOf) }));
  return validateReport({
    ...body,
    fileName: saved.fileName,
    scholarships: rows.filter(({ s }) => edits.has(s.code)).map(({ s, scholars }) => {
      const e = edits.get(s.code);
      // Each scholar's entered allowances, by student number.
      const entered = e.entered && typeof e.entered === 'object' ? e.entered : {};
      return { ...s, category: e.category, specialFunding: e.specialFunding, allowances: e.allowances, adjustment: e.adjustment,
        scholars: scholars.map(r => ({ ...r, entered: entered[r.studentId] })) };
    }),
  });
}

// PUT /api/fse/:id — edits a generated report (see editReport).
router.put('/:id', requireAdso, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid report id.' });
  try {
    const doc = await FseReport.findById(id);
    if (!doc) return res.status(404).json({ error: 'Report not found.' });
    const { report, error } = editReport(doc.toObject(), req.body || {});
    if (error) return res.status(400).json({ error });
    doc.set({ ...report, updatedBy: req.adminUser.email });
    const out = (await doc.save()).toObject();
    res.json({ report: { ...out, id: String(out._id) } });
  } catch (err) {
    console.error('Edit FSE report error:', err);
    res.status(500).json({ error: 'Failed to save the FSE report.' });
  }
});

// DELETE /api/fse/:id
router.delete('/:id', requireAdso, async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid report id.' });
  try {
    const report = await FseReport.findById(id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    // To the Trash for 30 days.
    await require('../utils/trash').moveToTrash({
      kind: 'fseReport', doc: report, title: `FSE report: ${report.term}, AY ${report.academicYear}`, office: 'LSO', by: req.adminUser,
    });
    res.json({ success: true, trashed: true });
  } catch (err) {
    console.error('Delete FSE report error:', err);
    res.status(500).json({ error: 'Failed to delete the FSE report.' });
  }
});

module.exports = router;
module.exports.validateReport = validateReport;
module.exports.editReport = editReport;
