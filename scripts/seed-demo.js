// Fills a separate demo database with sample data — applications in every
// status, renewals, duty hours (logs, offices, credited events and claims),
// announcements — so every screen has something to show. Never touches the
// real database: the target name must contain "demo".
//
//   node scripts/seed-demo.js                        # database aniskolar_demo
//   node scripts/seed-demo.js --db aniskolar_demo2
//   node scripts/seed-demo.js --head you@dlsud.edu.ph   # you're the Registrar head
//
// It wipes the demo database (and the demo file container) first, so it
// can be re-run any time. Sample files (PDF documents, an announcement
// image) go to the Azure container "aniskolar-demo" (or GridFS without
// Azure), never the real one.
//
// Signing in: sample students have no Clerk accounts, so they're for the
// admin side. The real students' records are copied in (same Clerk ids),
// so your own student account works: it gets an approved SFAG whose duty
// hours are done and evaluated. The real office heads (Duty hours →
// Offices) are kept on their offices, so a head can sign in too: the
// Registrar has duties to confirm and a scholar ready to evaluate. To run the app on the demo data, add to the backend .env:
//   MONGODB_DB=aniskolar_demo
//   AZURE_STORAGE_CONTAINER=aniskolar-demo
// and restart; remove both lines to go back to the real data.
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ quiet: true });

const dbArg = process.argv.indexOf('--db');
const DB_NAME = dbArg > -1 ? process.argv[dbArg + 1] : 'aniskolar_demo';
if (!/demo/i.test(DB_NAME || '')) {
  console.error('The demo database name must contain "demo" (this script wipes it).');
  process.exit(1);
}
// Sample files never go to the real container.
process.env.AZURE_STORAGE_CONTAINER = 'aniskolar-demo';

const zlib = require('zlib');
const mongoose = require('mongoose');
const Student = require('../models/Student');
const Application = require('../models/Application');
const Renewal = require('../models/Renewal');
const RenewalPeriod = require('../models/RenewalPeriod');
const Announcement = require('../models/Announcement');
const DutyLog = require('../models/DutyLog');
const DutySetting = require('../models/DutySetting');
const DutyEvent = require('../models/DutyEvent');
const Message = require('../models/Message');
const ScholarshipSetting = require('../models/ScholarshipSetting');
const MessageThread = require('../models/MessageThread');
const { RENEWAL_DOCUMENTS } = require('../models/RenewalPeriod');
const { findScholarship } = require('../data/scholarships');
const { officeDocuments } = require('../data/officeForms');
const { findProgram } = require('../data/programs');
const { nextReferenceCode } = require('../utils/referenceCode');
const { EVALUATION_ITEMS } = require('../utils/renewals');
const store = require('../utils/gridfs');

const ADMIN = 'demo.adso@dlsud.edu.ph';
const ADMIN_NAME = 'AdSO (demo)';
// Who reviews each office's scholarships.
const REVIEWERS = {
  LSO: { email: ADMIN, name: ADMIN_NAME },
  POLCA: { email: 'demo.polca@dlsud.edu.ph', name: 'POLCA (demo)' },
  ALUMNI: { email: 'demo.alumni@dlsud.edu.ph', name: 'Alumni Office (demo)' },
  SDO: { email: 'demo.sdo@dlsud.edu.ph', name: 'SDO (demo)' },
  VICISSITUDE: { email: 'demo.vicissitude@dlsud.edu.ph', name: 'Vicissitude (demo)' },
  ROTC: { email: 'demo.rotc@dlsud.edu.ph', name: 'ROTC Office (demo)' },
  USG: { email: 'demo.usg@dlsud.edu.ph', name: 'USG (demo)' },
  HERALDO: { email: 'demo.heraldo@dlsud.edu.ph', name: 'Heraldo Filipino (demo)' },
  CBAASG: { email: 'demo.cbaasg@dlsud.edu.ph', name: 'CBAASG (demo)' },
  CICSSG: { email: 'demo.cicssg@dlsud.edu.ph', name: 'CICSSG (demo)' },
  CEATSG: { email: 'demo.ceatsg@dlsud.edu.ph', name: 'CEATSG (demo)' },
  CCJESG: { email: 'demo.ccjesg@dlsud.edu.ph', name: 'CCJESG (demo)' },
};

// Documents for the partner offices' scholarships (as listed on each
// scholarship's page); CBAASG, SDO and ROTC follow the office form.
const OFFICE_DOCS = {
  s8: () => ['Certificate of Registration (COR)', 'Copy of grades from the previous semester'],
  s11: () => ['Application letter addressed to the University Student Government', 'Financial Aid Grant Application Form', 'Certificate of Registration (COR) for the current semester', 'Copy of grades from the previous semester', "Parents' ITR or Certificate of Indigency", 'Photograph of the house with the applicant and parent/guardian', 'Electricity and water bills (last 3 months)', 'DLSU-D ID', "Parent/guardian's government-issued ID", 'SWAFO clearance'],
  s12: () => ['Certificate of Registration (COR)', 'List of published works this term'],
  s15: () => ['Letter of intent', 'Certificate of Registration (COR)', 'Copy of grades from the previous semester', 'Letter of recommendation', 'Income Tax Return (ITR) or Certificate of Employment', 'Water bills (last 2 months)', 'Electricity bills (last 2 months)', 'Photo of the inside of the house', 'Photo of the outside of the house'],
  s16: () => ['Certificate of Registration (COR)', 'Grades from the previous semester', "Parents' latest ITR or affidavit of non-filing", 'Written application to the CEATSG Governor', 'Electricity and water billing statements', 'Vicinity map', 'Photos of the household'],
  s17: () => ['Recommendation letter from the Department Chair', 'Copy of grades', 'Certificate of Registration (COR)', 'Certificate of Indigency'],
};
const d = s => new Date(s);

// --- Sample files --------------------------------------------------------------

// A one-page PDF with a few lines of text.
function samplePdf(lines) {
  const esc = s => s.replace(/[\\()]/g, m => `\\${m}`).replace(/[^\x20-\x7e]/g, '?');
  const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 20 : 12} Tf 60 ${740 - i * 28} Td (${esc(l)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// A green banner PNG (for the announcement image).
function bannerPng(width = 800, height = 420) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3;
      const t = (x + y) / (width + height);
      raw[i] = Math.round(0 + 40 * t); raw[i + 1] = Math.round(110 + 80 * t); raw[i + 2] = Math.round(60 + 40 * t);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function docs(labels, owner, slotKeys = []) {
  return Promise.all(labels.map(async (label, i) => {
    const buffer = samplePdf(['SAMPLE DOCUMENT', label, `Applicant: ${owner}`, 'Demo data for testing AniSkolar - not a real document.']);
    const filename = `${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.pdf`;
    const fileId = await store.putFile({ buffer, filename, mimetype: 'application/pdf', metadata: { kind: 'demo' } });
    return { docType: label, ...(slotKeys[i] ? { slotKey: slotKeys[i] } : {}), fileId, filename, mimetype: 'application/pdf', size: buffer.length };
  }));
}

// --- People ----------------------------------------------------------------------

const PEOPLE = [
  ['Maria', 'Santos', 'Reyes', 'BSIT', '1st Year', 3.45],
  ['Juan Miguel', 'Cruz', 'dela Cruz', 'BSCS', '2nd Year', 3.2],
  ['Angela', 'Bautista', 'Garcia', 'BSA', '3rd Year', 3.6],
  ['Carlo', 'Mendoza', 'Villanueva', 'BSCE', '4th Year', 2.9],
  ['Bea', 'Ramos', 'Aquino', 'BSEd-Eng', '1st Year', 3.1],
  ['Paolo', 'Torres', 'Castillo', 'BSCrim', '2nd Year', 2.75],
  ['Kristine', 'Navarro', 'Flores', 'BSPsych', '3rd Year', 3.8],
  ['Mark Anthony', 'Lim', 'Gonzales', 'BSME', '5th Year', 3.0],
  ['Jasmine', 'Ocampo', 'Rivera', 'BMMA', '1st Year', 3.3],
  ['Rafael', 'Domingo', 'Salazar', 'BSBA-BE', '2nd Year', 2.6],
  ['Patricia', 'Aguilar', 'Mercado', 'BSIHM', '3rd Year', 3.5],
  ['Joshua', 'Fernandez', 'Pascual', 'BSAM', '4th Year', 3.9],
  ['Nicole', 'Valdez', 'Soriano', 'ABComm', '1st Year', 3.25],
  ['Gabriel', 'Manalo', 'Tolentino', 'BSArch', '2nd Year', 3.05],
  // For the partner offices' scholarships (Nov 2026).
  ['Andrea', 'Lopez', 'Cruz', 'BSIT', '3rd Year', 3.4],
  ['Miguel', 'Reyes', 'Santiago', 'BSCS', '4th Year', 3.1],
  ['Sofia', 'Garcia', 'del Rosario', 'BSA', '2nd Year', 3.5],
  ['Daniel', 'Cruz', 'Bautista', 'BSBA-MM', '3rd Year', 3.2],
  ['Lea', 'Santos', 'Manalo', 'BSCrim', '3rd Year', 3.3],
  ['Enzo', 'Ramos', 'Villar', 'BSCE', '2nd Year', 3.0],
  ['Bianca', 'Flores', 'Aquino', 'BSCpE', '3rd Year', 3.45],
  ['Kevin', 'Navarro', 'Dizon', 'BSPsych', '1st Year', 3.2],
  ['Camille', 'Torres', 'Ramirez', 'ABComm', '2nd Year', 3.6],
  ['Rico', 'Mendoza', 'Pascual', 'BSEd-Eng', '3rd Year', 2.8],
  ['Ivy', 'Gomez', 'Castro', 'ABComm', '3rd Year', 3.4],
];

// Sign-up today: everything but the telephone is filled in, confirmed.
const SUFFIX = { 1: 'Jr.', 7: 'II' };
function makeStudent([first, middle, last, code, yearLevel, gpa], i) {
  const program = findProgram(code);
  const suffix = SUFFIX[i] || '';
  const entry = { '1st Year': 2026, '2nd Year': 2025, '3rd Year': 2024, '4th Year': 2023, '5th Year': 2022 }[yearLevel];
  const studentNumber = `${entry}${String(10100 + i * 7).padStart(5, '0')}`;
  // Reserved .invalid domain: sample students are never really emailed.
  const email = `demo.${first.split(' ')[0].toLowerCase()}.${last.replace(/\s+/g, '').toLowerCase()}@aniskolar-demo.invalid`;
  return {
    clerkId: `demo_${studentNumber}`,
    studentNumber,
    firstName: first, middleName: middle, lastName: last,
    name: [first, middle, last, suffix].filter(Boolean).join(' ').toUpperCase(),
    ...(suffix ? { nameSuffix: suffix } : {}),
    email,
    programCode: program.code, course: program.name, college: program.college,
    yearLevel, gpa, section: `${code.replace(/[^A-Z]/g, '').slice(0, 3)}${yearLevel[0]}${(i % 3) + 1}`,
    mobileNumber: `0917${String(1000000 + i * 1234).slice(0, 7)}`,
    homeAddress: `${10 + i} Sampaguita St.`, cityMunicipality: 'Dasmariñas', province: 'Cavite', zipCode: '4115', country: 'Philippines',
    civilStatus: 'Single', nationality: 'Filipino', placeOfBirth: ['Dasmariñas, Cavite', 'Imus, Cavite', 'Bacoor, Cavite', 'Manila'][i % 4],
    dateOfBirth: d(`${entry - 18}-0${(i % 9) + 1}-15`),
    fatherName: `${['Jose', 'Ramon', 'Eduardo', 'Rolando'][i % 4]} ${last}`, motherName: `${['Elena', 'Rosa', 'Teresita', 'Liza'][i % 4]} ${last}`,
    // Bea's father passed away (no contact, can't be the guardian).
    ...(i === 4 ? { fatherDeceased: true } : { fatherContactNo: `0918${String(2000000 + i * 4321).slice(0, 7)}` }),
    motherContactNo: `0919${String(3000000 + i * 2345).slice(0, 7)}`,
    guardianType: 'mother',
    profileConfirmedAt: d('2026-06-01T09:00:00+08:00'),
  };
}

// --- Application payloads ------------------------------------------------------

function standardInfo(s) {
  return { firstName: s.firstName, middleName: s.middleName, lastName: s.lastName, email: s.email, phone: s.mobileNumber, studentNumber: s.studentNumber, program: s.course, yearLevel: s.yearLevel, gpa: String(s.gpa) };
}

function grantSections(s, extra = {}) {
  return {
    personalInfo: {
      lastName: s.lastName, firstName: s.firstName, middleName: s.middleName, studentNumber: s.studentNumber, course: s.course, yearLevel: s.yearLevel,
      dateOfBirth: s.dateOfBirth.toISOString().slice(0, 10), placeOfBirth: 'Dasmariñas, Cavite', civilStatus: 'Single', gender: 'Female',
      citizenship: 'Filipino', religion: 'Roman Catholic', email: s.email, secondarySchool: 'Dasmariñas National High School', secondarySchoolType: 'Public',
    },
    contactSchool: { streetAddress: s.homeAddress, barangay: 'Salitran II', municipality: 'Dasmariñas', province: 'Cavite', landlineNo: '', mobileNo: s.mobileNumber },
    parentsGuardian: {
      father: { name: s.fatherName, occupation: 'Tricycle driver', monthlyIncome: 12000 },
      mother: { name: s.motherName, occupation: 'Vendor', monthlyIncome: 8000 },
      guardian: { name: '', relationship: '', address: '', landlineNo: '', mobileNo: '' },
    },
    siblings: [{ id: 'sib1', name: `Ana ${s.lastName}`, civilStatus: 'Single', age: 14, school: 'Dasmariñas National High School', yearLevel: 'Grade 9', schoolType: 'Public', company: '' }],
    assetsExpenses: { houseTenure: 'Rented', houseValue: '', hasAutomobile: 'No', automobileValue: '', familyIncomeBracket: 'Below ₱20,000', monthlyExpensesBracket: '₱10,000–₱20,000' },
    agreement: { agreed: true, applicantName: `${s.firstName} ${s.lastName}`, parentGuardianName: s.motherName },
    ...extra,
  };
}

const SFAG_DOCS = [
  ['Application letter from parent/guardian', 'applicationLetter'], ['Recommendation letter', 'recommendationLetter'], ['Personal essay with 2x2 photo', 'personalEssay'],
  ['Certificate of indigency', 'indigency'], ["Parents' latest ITR", 'incomeProof'], ['Utility bills (electric and water)', 'utilityBills'],
  ['Pictures of the residence', 'residencePictures'], ['Hand-drawn vicinity sketch map', 'vicinityMap'],
];

function history(steps, office = 'LSO') {
  const by = REVIEWERS[office];
  return steps.map(([status, at, note]) => ({
    status, changedAt: d(at), ...(note ? { note } : {}),
    ...(status === 'Submitted' || status === 'Resubmitted' ? { changedBy: 'student' } : { changedBy: by.email, changedByName: by.name, changedByOffice: office }),
  }));
}

// --- Main ------------------------------------------------------------------------

(async () => {
  // The real students (same Clerk ids) so their accounts work on the demo data.
  const realDb = process.env.MONGODB_DB && !/demo/i.test(process.env.MONGODB_DB) ? { dbName: process.env.MONGODB_DB } : {};
  const realConn = await mongoose.createConnection(process.env.MONGODB_URI, realDb).asPromise();
  const realStudents = await realConn.db.collection('students').find().toArray();
  const realOffices = (await realConn.db.collection('dutysettings').findOne({ _id: 'duty' }))?.officeSlots ?? [];
  await realConn.close();

  await mongoose.connect(process.env.MONGODB_URI, { dbName: DB_NAME });
  const db = mongoose.connection.db;
  if (db.databaseName !== DB_NAME || !/demo/i.test(db.databaseName)) throw new Error('Not the demo database.');
  console.log(`Seeding ${db.databaseName}…`);
  for (const c of await db.listCollections().toArray()) await db.dropCollection(c.name);
  if (store.azureEnabled()) {
    const container = await store.getContainer();
    for await (const b of container.listBlobsFlat()) await container.deleteBlob(b.name);
  }

  // Students
  const fake = PEOPLE.map(makeStudent);
  await Student.insertMany(fake);
  await db.collection('students').insertMany(realStudents);
  const S = Object.fromEntries(fake.map((s, i) => [i, s]));
  // Verification and a correction request, for the profile tags.
  await Student.updateOne({ studentNumber: S[0].studentNumber }, { $set: { 'verification.program': { verifiedAt: d('2026-08-20'), verifiedBy: ADMIN, verifiedByName: ADMIN_NAME, office: 'LSO' } } });
  await Student.updateOne({ studentNumber: S[2].studentNumber }, { $push: { correctionRequests: { group: 'gpa', message: 'My GPA last semester was 3.65, not 3.60.', status: 'open', createdAt: d('2026-10-10') } } });
  // A locked detail (middle name): the request also reaches the AdSO in Messages.
  await Student.updateOne({ studentNumber: S[5].studentNumber }, { $push: { correctionRequests: { group: 'personal', message: 'My middle name is Tolentino, not Torres. I attached my PSA birth certificate in Messages.', status: 'open', createdAt: d('2026-10-20') } } });

  const apps = [];
  async function app(s, scholarshipId, status, opts = {}) {
    const sch = findScholarship(scholarshipId);
    const created = d(opts.created);
    const steps = opts.direct ? [] : [['Submitted', opts.created]];
    if (opts.revised) steps.push(['Needs Revision', opts.revised, 'Please upload a clearer copy of your certificate of indigency.'], ['Resubmitted', opts.resubmitted || opts.revised]);
    if (!opts.direct && status !== 'Submitted' && status !== 'Resubmitted') steps.push(['Under Evaluation', opts.evaluated || opts.created]);
    if (status === 'Approved') steps.push(['Approved', opts.decided, opts.note]);
    if (status === 'Rejected') steps.push(['Rejected', opts.decided, opts.note || 'Your family income is above the bracket for this grant this year.']);
    if (status === 'Needs Revision') steps.push(['Needs Revision', opts.decided, opts.note || 'Please upload a clearer copy of your certificate of indigency.']);
    const owner = `${s.firstName} ${s.lastName}`;
    let documents;
    if (sch.formType === 'sfag') documents = await docs(SFAG_DOCS.map(x => x[0]), owner, SFAG_DOCS.map(x => x[1]));
    else if (scholarshipId === 's2') documents = await docs(['Certificate of Ranking (number of graduates)', 'Grade 12 Report Card / Form 138'], owner);
    else if (scholarshipId === 's6') documents = await docs(['Latest report card', 'Certificate of employment of parent (DLSU-D)', 'PSA birth certificate'], owner);
    else if (scholarshipId === 's3') documents = await docs(['Letter from parent/guardian', 'Personal essay with 2x2 photo', 'Certificate of indigency', "Parents' latest ITR", 'Senior HS grades', 'Recommendation letter', 'Pictures of the residence', 'Vicinity sketch map', 'DLSU-D entrance test result', '2x2 photo'], owner, ['parentLetter', 'personalEssay', 'indigency', 'incomeProof', 'shsGrades', 'recommendationLetter', 'residencePictures', 'vicinityMap', 'entranceTestResult', 'photo2x2']);
    else if (OFFICE_DOCS[scholarshipId]) documents = await docs(OFFICE_DOCS[scholarshipId](), owner);
    else if (opts.answers && officeDocuments(scholarshipId, opts.answers)) documents = await docs(officeDocuments(scholarshipId, opts.answers), owner);
    else documents = await docs(['PSA birth certificate', 'Letter from parent', "Parents' latest ITR", 'Certificate of employment', 'Grade 12 report card', 'Vicinity sketch map', 'DLSU-D entrance test result', 'Proof of relation to alumnus'], owner, ['psaBirthCertificate', 'parentLetter', 'incomeProof', 'employmentCertificate', 'grade12Card', 'vicinityMap', 'entranceTestResult', 'proofOfRelation']);

    const doc = {
      studentNumber: s.studentNumber, scholarshipId, scholarshipName: sch.name, office: sch.office, applicationFormType: sch.formType,
      referenceCode: await nextReferenceCode(sch, created), documents, status: status === 'Submitted' || status === 'Resubmitted' ? undefined : status,
      firstName: s.firstName, middleName: s.middleName, lastName: s.lastName,
      history: history(steps, sch.office), createdAt: created, updatedAt: d(opts.decided || opts.created),
    };
    if (['Approved', 'Rejected', 'Needs Revision'].includes(status)) Object.assign(doc, { reviewedBy: REVIEWERS[sch.office].email, reviewedAt: d(opts.decided), reviewNote: steps[steps.length - 1][2], decisionOffice: sch.office });
    if (sch.formType === 'standard') doc.standardInfo = { ...standardInfo(s), ...(opts.answers ? { officeAnswers: opts.answers } : {}) };
    if (opts.assessment) doc.officeAssessment = { ...opts.assessment, ...(opts.direct ? { directorApproved: true } : {}), updatedBy: REVIEWERS[sch.office].email, updatedAt: d(opts.decided || opts.evaluated || opts.created) };
    if (opts.direct) doc.awardedDirectly = true;
    if (sch.formType === 'sfag') Object.assign(doc, grantSections(s));
    if (sch.formType === 'polca') Object.assign(doc, grantSections(s, { eligibilityAnswers: { hsGeneralAverage: 91, lowestHsGrade: 85, notRelatedToBoardMember: true }, evaluationSheet: { statements: { applicant: { agreed: true, name: owner, date: opts.created.slice(0, 10) }, parent: { agreed: true, name: s.motherName, date: opts.created.slice(0, 10) } } } }));
    if (sch.formType === 'alumni') Object.assign(doc, grantSections(s, { eligibilityAnswers: { alumnusName: s.fatherName, relationship: 'Parent', institution: 'DLSU-Dasmariñas', batchYear: 1999 } }));
    if (sch.formType === 'sfag') doc.sfagPercentageRequested = opts.requested ?? opts.percentage ?? [100, 75, 50][apps.length % 3];
    if (opts.percentage) Object.assign(doc, { sfagPercentage: opts.percentage, sfagPercentageSetBy: ADMIN, sfagPercentageSetAt: d(opts.decided) });
    // An office (POLCA / Alumni) approving sends the application to the AdSO.
    if (sch.office !== 'LSO' && status === 'Approved') {
      Object.assign(doc, { forwardedAt: d(opts.decided), forwardedBy: REVIEWERS[sch.office].email, forwardBatchId: `${sch.office}-approved-${d(opts.decided).getTime()}` });
      doc.history.push({ status: 'Forwarded to LSO', changedBy: 'system', changedByOffice: sch.office, changedAt: d(opts.decided) });
    }
    if (opts.ended) Object.assign(doc, { endedAt: d(opts.ended), endReason: 'Graduated', endedBy: REVIEWERS[sch.office].email });
    apps.push(doc);
  }

  // SFAG, A.Y. 2026–27 (applied June–July). Approved ones are this term's duty roster.
  await app(S[0], 's1', 'Approved', { created: '2026-06-18T09:00:00+08:00', decided: '2026-07-20T10:00:00+08:00', percentage: 100, note: 'Congratulations! You are granted a 100% tuition discount.' });
  // Applied for 100%, granted 75% (the AdSO changed it).
  await app(S[1], 's1', 'Approved', { created: '2026-06-19T09:00:00+08:00', decided: '2026-07-20T10:05:00+08:00', percentage: 75, requested: 100 });
  await app(S[2], 's1', 'Approved', { created: '2026-06-20T09:00:00+08:00', decided: '2026-07-20T10:10:00+08:00', percentage: 50 });
  await app(S[3], 's1', 'Approved', { created: '2026-06-22T09:00:00+08:00', decided: '2026-07-21T10:00:00+08:00', percentage: 25 });
  await app(S[4], 's1', 'Approved', { created: '2026-06-23T09:00:00+08:00', decided: '2026-07-21T10:05:00+08:00', percentage: 50 });
  await app(S[7], 's1', 'Approved', { created: '2026-06-24T09:00:00+08:00', decided: '2026-07-21T10:10:00+08:00', percentage: 100 });
  await app(S[5], 's1', 'Under Evaluation', { created: '2026-07-01T09:00:00+08:00', evaluated: '2026-07-10T09:00:00+08:00' });
  await app(S[8], 's1', 'Needs Revision', { created: '2026-07-02T09:00:00+08:00', evaluated: '2026-07-10T09:00:00+08:00', decided: '2026-07-12T09:00:00+08:00' });
  await app(S[9], 's1', 'Rejected', { created: '2026-06-25T09:00:00+08:00', evaluated: '2026-07-05T09:00:00+08:00', decided: '2026-07-15T09:00:00+08:00' });
  await app(S[12], 's1', 'Submitted', { created: '2026-07-03T15:00:00+08:00' });
  await app(S[6], 's1', 'Resubmitted', { created: '2026-06-28T09:00:00+08:00', revised: '2026-07-06T09:00:00+08:00', resubmitted: '2026-07-08T09:00:00+08:00' });

  // Entrance
  await app(S[12], 's2', 'Approved', { created: '2026-06-05T09:00:00+08:00', decided: '2026-06-25T09:00:00+08:00', note: 'Rank 1 — 100% tuition discount for the 1st semester.' });
  await app(S[13], 's2', 'Submitted', { created: '2026-06-15T09:00:00+08:00' });
  await app(S[8], 's2', 'Rejected', { created: '2026-06-10T09:00:00+08:00', decided: '2026-06-24T09:00:00+08:00', note: 'Your batch had fewer than 100 graduates.' });

  // EBPSP: S[0] also holds the SFAG, the "approved for two, keep one" case
  // (she chooses on My Scholarship).
  await app(S[0], 's6', 'Approved', { created: '2026-07-25T09:00:00+08:00', decided: '2026-08-05T09:00:00+08:00', note: '1st availment — 100% tuition discount.' });
  await app(S[10], 's6', 'Under Evaluation', { created: '2026-08-01T09:00:00+08:00', evaluated: '2026-08-03T09:00:00+08:00' });

  // POLCA (reviewed by POLCA; approved ones are forwarded to the AdSO)
  await app(S[13], 's3', 'Approved', { created: '2026-06-12T09:00:00+08:00', decided: '2026-07-01T09:00:00+08:00', note: 'Approved by POLCA. Forwarded to the AdSO.' });
  await app(S[6], 's3', 'Submitted', { created: '2026-06-30T09:00:00+08:00' });
  await app(S[1], 's3', 'Under Evaluation', { created: '2026-06-16T09:00:00+08:00', evaluated: '2026-06-22T09:00:00+08:00' });
  await app(S[4], 's3', 'Needs Revision', { created: '2026-06-17T09:00:00+08:00', evaluated: '2026-06-22T09:00:00+08:00', decided: '2026-06-24T09:00:00+08:00', note: 'The evaluation sheet is missing your parent\'s signature. Please resubmit.' });
  await app(S[5], 's3', 'Rejected', { created: '2026-06-13T09:00:00+08:00', evaluated: '2026-06-20T09:00:00+08:00', decided: '2026-06-27T09:00:00+08:00', note: 'Your high school general average is below 90.' });
  await app(S[12], 's3', 'Resubmitted', { created: '2026-06-11T09:00:00+08:00', revised: '2026-06-18T09:00:00+08:00', resubmitted: '2026-06-21T09:00:00+08:00' });

  // Alumni (reviewed by the Alumni Office; approved ones are forwarded to the AdSO)
  await app(S[10], 's4', 'Under Evaluation', { created: '2026-06-14T09:00:00+08:00', evaluated: '2026-06-20T09:00:00+08:00' });
  await app(S[2], 's4', 'Submitted', { created: '2026-07-01T09:00:00+08:00' });
  await app(S[7], 's4', 'Approved', { created: '2026-06-09T09:00:00+08:00', decided: '2026-06-30T09:00:00+08:00', note: 'Approved by the Alumni Association. Forwarded to the AdSO.' });
  await app(S[8], 's4', 'Needs Revision', { created: '2026-06-15T09:00:00+08:00', evaluated: '2026-06-19T09:00:00+08:00', decided: '2026-06-23T09:00:00+08:00', note: 'Please upload proof of your relationship to the alumnus (PSA birth certificate).' });
  await app(S[9], 's4', 'Rejected', { created: '2026-06-10T09:00:00+08:00', evaluated: '2026-06-16T09:00:00+08:00', decided: '2026-06-26T09:00:00+08:00', note: 'The alumnus is not related within the 2nd degree of consanguinity.' });

  // Last year's SFAG scholars (A.Y. 2025–26), up for renewal this term.
  await app(S[6], 's1', 'Approved', { created: '2025-06-20T09:00:00+08:00', decided: '2025-07-20T09:00:00+08:00', percentage: 75 });
  await app(S[10], 's1', 'Approved', { created: '2025-06-21T09:00:00+08:00', decided: '2025-07-20T09:00:00+08:00', percentage: 50 });
  await app(S[11], 's1', 'Approved', { created: '2025-06-22T09:00:00+08:00', decided: '2025-07-20T09:00:00+08:00', percentage: 100 });
  await app(S[9], 's1', 'Approved', { created: '2025-06-23T09:00:00+08:00', decided: '2025-07-20T09:00:00+08:00', percentage: 25 });
  await app(S[13], 's1', 'Approved', { created: '2025-06-24T09:00:00+08:00', decided: '2025-07-20T09:00:00+08:00', percentage: 50 });
  // Earlier POLCA scholars (no renewals: they keep it until they graduate).
  // CEAT now has 2 (S[3] and S[13]), so it's full: S[7] (CEAT) can't apply.
  await app(S[3], 's3', 'Approved', { created: '2024-06-12T09:00:00+08:00', decided: '2024-07-01T09:00:00+08:00' });
  await app(S[5], 's3', 'Approved', { created: '2023-06-13T09:00:00+08:00', decided: '2023-07-01T09:00:00+08:00', ended: '2026-06-30T09:00:00+08:00' });
  await app(S[11], 's3', 'Approved', { created: '2025-06-14T09:00:00+08:00', decided: '2025-07-01T09:00:00+08:00' });
  // Earlier Alumni scholars (2 campus-wide, no renewals). With S[7] (above)
  // and S[12] the 2 slots are full; S[4] and S[1] have graduated.
  await app(S[12], 's4', 'Approved', { created: '2025-06-10T09:00:00+08:00', decided: '2025-06-30T09:00:00+08:00' });
  await app(S[4], 's4', 'Approved', { created: '2022-06-11T09:00:00+08:00', decided: '2022-06-30T09:00:00+08:00', ended: '2026-06-30T09:00:00+08:00' });
  await app(S[1], 's4', 'Approved', { created: '2022-06-12T09:00:00+08:00', decided: '2022-06-30T09:00:00+08:00', ended: '2026-06-30T09:00:00+08:00' });

  // --- Partner offices' scholarships (Nov 2026) ---------------------------------
  const T = (date, time = '09:00') => `${date}T${time}:00+08:00`;
  // CICSSG Padayon Pioneers (2 grantees, one semester): one granted, one
  // with an interview booked, one new. CICS students only.
  const padayon = { noMajorOffense: true, noAllowanceScholarship: true };
  await app(S[14], 's15', 'Approved', { created: T('2026-08-20'), evaluated: T('2026-08-25'), decided: T('2026-09-05'), answers: padayon, assessment: { interviewDate: '2026-09-01', interviewTime: '14:00' }, note: 'Congratulations! You are one of this semester\'s Padayon Pioneers grantees (50%, up to ₱50,000).' });
  await app(S[15], 's15', 'Under Evaluation', { created: T('2026-11-03'), evaluated: T('2026-11-06'), answers: padayon, assessment: { interviewDate: '2026-11-18', interviewTime: '10:30' } });
  await app(S[1], 's15', 'Submitted', { created: T('2026-11-10'), answers: padayon });
  // CBAASG: Achie (one per department) and the officers' 25%.
  await app(S[16], 's13', 'Submitted', { created: T('2026-11-09'), answers: { department: 'ACD', noOtherScholarship: true, noMajorOffense: true, taxExemption: 'yes' } });
  await app(S[9], 's13', 'Under Evaluation', { created: T('2026-11-02'), evaluated: T('2026-11-05'), answers: { department: 'BMD', noOtherScholarship: true, noMajorOffense: true, taxExemption: 'no' }, assessment: { initialInterview: '2026-11-16', finalInterview: '2026-11-23' } });
  await app(S[17], 's14', 'Approved', { created: T('2026-08-18'), evaluated: T('2026-08-22'), decided: T('2026-09-02'), answers: { branch: 'executive', position: 'Vice President for Finance', activeInvolvement: true, noMajorOffense: true, taxExemption: 'no' }, assessment: { initialInterview: '2026-08-26', finalInterview: '2026-08-29' }, note: 'Approved: 25% of tuition, miscellaneous and other fees.' });
  // CEATSG Financial Aid: one granted, one waiting for the interview.
  await app(S[8], 's16', 'Approved', { created: T('2026-08-19'), evaluated: T('2026-08-24'), decided: T('2026-09-04'), answers: { noConcurrentScholarship: true }, assessment: { interviewDate: '2026-08-28', interviewTime: '13:00', grant: 25000 }, note: 'Granted ₱25,000 from this semester\'s CEATSG scholarship fund.' });
  await app(S[19], 's16', 'Under Evaluation', { created: T('2026-11-04'), evaluated: T('2026-11-07'), answers: { noConcurrentScholarship: true }, assessment: { interviewDate: '2026-11-17', interviewTime: '15:00' } });
  // CCJESG officers' grant (capped by position).
  await app(S[18], 's17', 'Approved', { created: T('2026-08-21'), evaluated: T('2026-08-26'), decided: T('2026-09-06'), answers: { position: 'chiefOfStaff', noViolation: true, activeOfficer: true }, assessment: { interviewDate: '2026-08-31', evaluationPassed: true, grant: 7000 }, note: 'Approved: ₱7,000 for this semester, credited at the end of the term.' });
  await app(S[5], 's17', 'Needs Revision', { created: T('2026-11-03'), evaluated: T('2026-11-05'), decided: T('2026-11-07'), answers: { position: 'legislative', noViolation: true, activeOfficer: true }, note: 'Please upload your Certificate of Indigency; the file you sent is your COR.' });
  // USG SFAG: last semester's grantee (can apply again) and this call.
  const usg = { noOtherScholarship: true, noMajorOffense: true };
  await app(S[23], 's11', 'Approved', { created: T('2026-04-08'), evaluated: T('2026-04-10'), decided: T('2026-04-20'), answers: usg, assessment: { verified: true, onsiteDate: '2026-04-15', onsiteTime: '10:00' }, note: 'You are one of the 35 grantees for the 2nd semester (₱15,000).' });
  await app(S[23], 's11', 'Submitted', { created: T('2026-11-10'), answers: usg });
  await app(S[22], 's11', 'Approved', { created: T('2026-09-01'), evaluated: T('2026-09-03'), decided: T('2026-09-15'), answers: usg, assessment: { verified: true, onsiteDate: '2026-09-08', onsiteTime: '13:30' }, note: 'Verified and confirmed on-site. ₱15,000 credited to your student account.' });
  await app(S[24], 's11', 'Under Evaluation', { created: T('2026-11-05'), evaluated: T('2026-11-06'), answers: usg, assessment: { verified: false } });
  // Heraldo Filipino and Vicissitude (their staff).
  await app(S[22], 's12', 'Under Evaluation', { created: T('2026-10-20'), evaluated: T('2026-10-22'), answers: { position: 'section', publishedWorks: 5 }, assessment: { evaluationScore: 92, publishedWorks: 5, officeHours: 94, merit: '2' } });
  await app(S[24], 's8', 'Approved', { created: T('2026-08-15'), evaluated: T('2026-08-20'), decided: T('2026-08-30'), answers: { member: 'board', position: 'Layout Artist', dutyHours: 40 }, assessment: { coordinatorScore: 4.6, boardScore: 4.8 }, note: 'Rating 4.68: 75% tuition discount.' });
  // Added by the office itself (no application): an SDO varsity player and
  // an ROTC officer (one semester, amount from the rank).
  await app(S[21], 's7', 'Approved', { direct: true, created: T('2026-08-12'), decided: T('2026-08-12'), answers: { playerType: 'incoming', sport: 'Basketball', coach: 'Coach Ramon Dizon' }, assessment: { tuitionDiscount: 75, matriculation: true }, note: 'Welcome to the team! Your discount starts this semester.' });
  await app(S[20], 's10', 'Approved', { direct: true, created: T('2026-08-14'), decided: T('2026-08-14'), answers: { rank: 'vice', activeDuty: true }, assessment: { amount: 20000 }, note: 'Congratulations on your rank! Your assistance is for this semester.' });

  // Real students: an approved SFAG so the student side has duty hours.
  for (const [i, r] of realStudents.entries()) {
    const s = { ...r, firstName: r.firstName || 'Student', middleName: r.middleName || '', lastName: r.lastName || 'Demo', mobileNumber: r.mobileNumber || '09170000000', homeAddress: r.homeAddress || 'Dasmariñas', course: r.course || 'Bachelor of Science in Information Technology', yearLevel: r.yearLevel || '3rd Year', gpa: r.gpa ?? 3.2, dateOfBirth: r.dateOfBirth || d('2005-01-01'), fatherName: r.fatherName || 'Father', motherName: r.motherName || 'Mother' };
    await app(s, 's1', 'Approved', { created: `2026-06-${String(15 + (i % 15)).padStart(2, '0')}T09:00:00+08:00`, decided: '2026-07-22T09:00:00+08:00', percentage: [50, 75, 25][i % 3], requested: [50, 100, 50][i % 3], note: 'Sample approval (demo data).' });
  }
  // Validated through the model, inserted raw so the sample dates stay.
  await db.collection('applications').insertMany(await Promise.all(apps.map(async a => {
    const { status, createdAt, updatedAt, ...rest } = a;
    const doc = new Application(status ? { ...rest, status } : rest);
    await doc.validate();
    return { ...doc.toObject(), createdAt, updatedAt };
  })));

  // Renewals. 1st semester 2026–27 (looked back on the 2nd semester): closed
  // and decided. 2nd semester 2026–27 (looks back on this term's duty):
  // open now; renewing waits for the office's evaluation.
  const TCG = RENEWAL_DOCUMENTS[0];
  const period = await RenewalPeriod.create({ scholarshipId: 's1', academicYear: 2026, term: '1st Semester', open: false, deadline: 'October 30, 2026', minGpa: 2.5, requiresEvaluation: true, notes: 'Submit your TCG from the Online Student Records Portal.', createdBy: ADMIN });
  const nextPeriod = await RenewalPeriod.create({ scholarshipId: 's1', academicYear: 2026, term: '2nd Semester', open: true, deadline: 'January 15, 2027', minGpa: 2.5, requiresEvaluation: true, notes: 'Submit your grades once your office has evaluated your duty for this semester.', createdBy: ADMIN });
  const evalScores = avg => Object.fromEntries(EVALUATION_ITEMS.map((it, i) => [it.key, Math.max(1, Math.min(5, Math.round(avg + ((i % 3) - 1) * 0.5)))]));
  const evaluationOf = (avg, evaluatorName, office, remarks, by = ADMIN, at = '2026-10-08') => {
    const scores = evalScores(avg);
    const average = Math.round((Object.values(scores).reduce((a, b) => a + b, 0) / EVALUATION_ITEMS.length) * 100) / 100;
    return { scores, average, evaluatorName, assignedOffice: office, remarks, enteredBy: by, enteredAt: d(at), source: 'office' };
  };
  const renewal = async (s, status, extra = {}, p = period) => {
    const office = findScholarship(p.scholarshipId).office;
    const by = REVIEWERS[office];
    const documents = extra.continuing === false ? [] : await docs([TCG], `${s.firstName} ${s.lastName}`);
    const at = extra.at ?? '2026-10-05';
    const steps = [{ status: 'Submitted', changedBy: 'student', changedAt: d(at) }];
    if (status !== 'Under Evaluation' && status !== 'Not Continuing') steps.push({ status, changedBy: by.email, changedByName: by.name, changedByOffice: office, changedAt: d('2026-10-12'), ...(extra.note ? { note: extra.note } : {}) });
    if (status === 'Not Continuing') steps[0].status = 'Not Continuing';
    return {
      periodId: p._id, studentNumber: s.studentNumber, scholarshipId: p.scholarshipId, scholarshipName: findScholarship(p.scholarshipId).name, office, academicYear: p.academicYear, term: p.term,
      continuing: extra.continuing !== false, ...(extra.continuing === false ? { notContinuingReason: 'OJT / internship', notContinuingDetails: 'OJT at a company in Makati this semester.' } : { gpa: extra.gpa ?? 3.2, hasFailingGrade: false }),
      documents, status, history: steps,
      ...(extra.evaluation ? { evaluation: extra.evaluation } : {}),
      ...(status !== 'Under Evaluation' && status !== 'Not Continuing' ? { reviewedBy: by.email, reviewedAt: d('2026-10-12'), reviewNote: extra.note } : {}),
    };
  };
  const pastEval = (avg, office, remarks) => evaluationOf(avg, { 'Office of the University Registrar': 'Dr. Sample Registrar', 'Accounting Office': 'Ms. Sample Accounting', "CICS Dean's Office": 'Dr. Sample Dean' }[office] ?? 'Sample Head', office, remarks);
  await Renewal.insertMany([
    await renewal(S[6], 'Renewed', { gpa: 3.7, evaluation: pastEval(4.6, 'Office of the University Registrar', 'Reliable and courteous with students at the counter.') }),
    await renewal(S[10], 'Renewed', { gpa: 3.4, evaluation: pastEval(4.3, 'Accounting Office', 'Accurate with the files. Could take more initiative.') }),
    await renewal(S[11], 'Renewed', { gpa: 3.85, evaluation: pastEval(4.8, 'Office of the University Registrar', 'Outstanding. Trained the new scholars.') }),
    await renewal(S[9], 'Not Renewed', { gpa: 2.3, note: 'GPA below 2.50 this semester.', evaluation: pastEval(3, "CICS Dean's Office", 'Often late; 30 of 120 hours rendered.') }),
    await renewal(S[13], 'Not Continuing', { continuing: false }),
  ]);
  // POLCA and Alumni have no renewals.

  // Duty hours: settings (hours from the AdSO + office slots + this term's
  // deadline), events, logs. Sample heads use .invalid emails (nobody signs
  // in as them); the real heads from the real database are kept on their
  // offices so they can sign in and use the office portal.
  const HEADS = {
    'Office of the University Registrar': ['Dr. Sample Registrar', 'demo.registrar.head@aniskolar-demo.invalid'],
    'Accounting Office': ['Ms. Sample Accounting', 'demo.accounting.head@aniskolar-demo.invalid'],
    "CICS Dean's Office": ['Dr. Sample Dean', 'demo.cics.head@aniskolar-demo.invalid'],
  };
  const norm = n => String(n || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // --head: this school email heads the Registrar in the demo.
  const headArg = process.argv.indexOf('--head');
  const headEmail = headArg > -1 ? String(process.argv[headArg + 1] || '').trim().toLowerCase() : '';
  if (headEmail && !/@dlsud\.edu\.ph$/.test(headEmail)) throw new Error('--head must be a @dlsud.edu.ph email.');
  if (headEmail) realOffices.push({ office: 'Office of the University Registrar', headName: 'Registrar Head', headEmail });
  for (const o of realOffices.filter(x => x.headEmail)) {
    const same = Object.keys(HEADS).find(k => norm(k) === norm(o.office));
    if (same) delete HEADS[same];
    HEADS[o.office] = [o.headName || 'Office head', o.headEmail];
  }
  const officeList = [
    { office: 'Office of the University Registrar', slots: 5 }, { office: 'Accounting Office', slots: 4 }, { office: 'Admissions and Scholarship Office', slots: 5 },
    { office: 'Aklatang Emilio Aguinaldo (Library)', slots: 2 }, { office: 'University Clinic', slots: 1 }, { office: "CICS Dean's Office", slots: 2 },
  ];
  for (const o of realOffices) if (!officeList.some(x => norm(x.office) === norm(o.office))) officeList.push({ office: o.office, slots: o.slots ?? 2 });
  const officeName = name => officeList.find(x => norm(x.office) === norm(name))?.office ?? name;
  const headOf = office => Object.entries(HEADS).find(([k]) => norm(k) === norm(office))?.[1];
  const REGISTRAR = officeName('Office of the University Registrar');
  await DutySetting.create({ _id: 'duty', officeSlots: officeList.map(o => (headOf(o.office) ? { ...o, headName: headOf(o.office)[0], headEmail: headOf(o.office)[1] } : o)), deadlines: [{ academicYear: 2026, term: '1st Semester', date: '2026-12-11' }], updatedBy: ADMIN });
  const [assembly, recollection, outreach] = await DutyEvent.insertMany([
    { name: "Scholars' General Assembly", date: '2026-08-28', organizer: 'COSA', creditHours: 3, academicYear: 2026, term: '1st Semester', createdBy: ADMIN },
    { name: 'Lasallian Recollection for Scholars', date: '2026-09-25', organizer: 'Scholarship office', creditHours: 4, academicYear: 2026, term: '1st Semester', createdBy: ADMIN },
    { name: 'Christmas Outreach', date: '2026-12-05', organizer: 'COSA', creditHours: 3, academicYear: 2026, term: '1st Semester', createdBy: ADMIN },
  ]);
  void outreach;

  // Hours each scholar needs this term (the AdSO's defaults).
  const NEED = { lower: { 100: 180, 75: 135, 50: 100, 25: 50 }, upper: { 100: 95, 75: 70, 50: 55, 25: 30 } };
  const need = (yearLevel, pct) => NEED[/1st|2nd/.test(yearLevel || '') ? 'lower' : 'upper'][pct];
  const hoursOf = e => (Number(e.timeOut.slice(0, 2)) * 60 + Number(e.timeOut.slice(3)) - Number(e.timeIn.slice(0, 2)) * 60 - Number(e.timeIn.slice(3))) / 60;
  // Weekday duties from Aug 17 that follow the duty rules (on the hour or
  // half hour, at least 1.5 h, never over 12–1, Fri until 5), until `hours`
  // are reached. Mornings first; afternoons too when there's a lot to do.
  function duties(hours, seed = 0, until = '2026-10-28') {
    const AM = [['08:00', '11:30'], ['08:30', '11:30'], ['09:00', '12:00'], ['08:00', '10:00']];
    const PM = [['13:00', '16:00'], ['13:30', '17:00'], ['14:00', '17:00'], ['13:00', '15:30']];
    const busy = hours > 120;
    const out = [];
    let total = 0;
    let day = new Date('2026-08-17T00:00:00Z');
    let k = seed;
    while (total < hours && day.toISOString().slice(0, 10) <= until) {
      const wd = day.getUTCDay();
      const date = day.toISOString().slice(0, 10);
      if (wd >= 1 && wd <= 5 && (busy || (k + day.getUTCDate()) % 4 !== 0)) {
        for (const [timeIn, timeOut] of busy ? [AM[k % 4], PM[k % 4]] : [(k % 2 ? PM : AM)[k % 4]]) {
          if (total >= hours) break;
          const e = { date, timeIn, timeOut: wd === 5 && timeOut > '17:00' ? '17:00' : timeOut };
          out.push(e);
          total += hoursOf(e);
        }
      }
      day = new Date(day.getTime() + 86400000);
      k++;
    }
    return out;
  }
  // Last semester's duties (Jan–Apr 2026), 3 hours each, confirmed.
  function pastDuties(hours, office) {
    const out = [];
    let day = new Date('2026-01-05T00:00:00Z');
    while (out.length * 3 < hours) {
      const wd = day.getUTCDay();
      if (wd >= 1 && wd <= 4) {
        const date = day.toISOString().slice(0, 10);
        out.push({ date, timeIn: '08:00', timeOut: '11:00', ...(headOf(office) ? { status: 'confirmed', reviewedBy: headOf(office)[1], reviewedAt: d(`${date}T18:00:00+08:00`) } : {}) });
      }
      day = new Date(day.getTime() + 86400000);
    }
    return out;
  }
  const claim = (event, status, note) => ({ event: event._id, status, claimedAt: d(`${event.date}T18:00:00+08:00`), ...(status !== 'Pending' ? { reviewedBy: ADMIN, reviewedAt: d('2026-10-01'), ...(note ? { note } : {}) } : {}) });
  // With a head: confirmed, except the last `waiting` duties (and one flagged).
  const reviewed = (office, entries, { waiting = 0, flag = false } = {}) => entries.map((e, i) => {
    const head = headOf(office);
    if (!head) return e;
    if (i >= entries.length - waiting) return e;
    if (flag && i === entries.length - waiting - 1) return { ...e, status: 'flagged', note: 'Not in the office that afternoon.', reviewedBy: head[1], reviewedAt: d('2026-10-20') };
    return { ...e, status: 'confirmed', reviewedBy: head[1], reviewedAt: d(`${e.date}T18:00:00+08:00`) };
  });
  const logOf = (s, office, entries, opts = {}) => ({
    studentNumber: s.studentNumber, academicYear: 2026, term: '1st Semester',
    ...(office ? { officeAssigned: office, officeAssignedBy: ADMIN, officeAssignedAt: d('2026-08-10') } : {}),
    deadline: '2026-12-11', entries: reviewed(office, entries, opts), specialEvents: [], eventClaims: opts.claims ?? [],
    ...(opts.evaluation ? { evaluation: opts.evaluation } : {}),
  });
  const regHead = headOf(REGISTRAR);
  const ACCOUNTING = officeName('Accounting Office');
  const CICS = officeName("CICS Dean's Office");
  await DutyLog.insertMany([
    // The Registrar: Maria has duties waiting to confirm (180 h needed, ~140 done).
    logOf(S[0], REGISTRAR, duties(140, 0), { waiting: 3, claims: [claim(assembly, 'Approved'), claim(recollection, 'Approved')] }),
    // Juan Miguel: one duty flagged, two waiting (135 h needed).
    logOf(S[1], REGISTRAR, duties(70, 1), { waiting: 2, flag: true, claims: [claim(assembly, 'Approved'), claim(recollection, 'Pending')] }),
    // Mark Anthony: 95 h needed, done and confirmed: ready to evaluate.
    logOf(S[7], REGISTRAR, duties(need('5th Year', 100) + 2, 2), { claims: [claim(assembly, 'Approved')] }),
    // Angela: done and evaluated by Accounting; she has renewed.
    logOf(S[2], ACCOUNTING, duties(need('3rd Year', 50) + 3, 3), { claims: [claim(assembly, 'Rejected', 'Not on the attendance sheet.')], evaluation: evaluationOf(4.2, headOf(ACCOUNTING)?.[0] ?? 'Ms. Sample Accounting', ACCOUNTING, 'Careful with the records and always on time.', headOf(ACCOUNTING)?.[1], '2026-10-22') }),
    // Carlo: still rendering hours in the CICS Dean's Office.
    logOf(S[3], CICS, duties(12, 4), { claims: [claim(recollection, 'Pending')] }),
    // Bea: assigned to the Library (no head in AniSkolar), nothing yet.
    logOf(S[4], officeName('Aklatang Emilio Aguinaldo (Library)'), []),
    logOf(S[6], officeName('Admissions and Scholarship Office'), duties(40, 5), { claims: [claim(assembly, 'Approved')] }),
    // Patricia: no office yet (Random assign / waiting card).
    logOf(S[10], null, []),
    // Real students: the first one is done and evaluated by the Registrar.
    ...realStudents.map((r, i) => {
      const pct = [50, 75, 25][i % 3];
      if (i === 0) {
        return logOf(r, REGISTRAR, duties(need(r.yearLevel, pct) + 2, 6), {
          claims: [claim(assembly, 'Approved')],
          evaluation: evaluationOf(4.6, regHead?.[0] ?? 'Dr. Sample Registrar', REGISTRAR, 'Very reliable at the counter and quick to learn the records system. Keep it up!', regHead?.[1], '2026-10-26'),
        });
      }
      return logOf(r, null, []);
    }),
    // Last term (2nd sem 2025–26): where last renewal's scholars did duty.
    { studentNumber: S[6].studentNumber, academicYear: 2025, term: '2nd Semester', officeAssigned: REGISTRAR, officeAssignedBy: ADMIN, entries: pastDuties(120, REGISTRAR), specialEvents: [] },
    { studentNumber: S[10].studentNumber, academicYear: 2025, term: '2nd Semester', officeAssigned: ACCOUNTING, officeAssignedBy: ADMIN, entries: pastDuties(120, ACCOUNTING), specialEvents: [] },
    { studentNumber: S[11].studentNumber, academicYear: 2025, term: '2nd Semester', officeAssigned: REGISTRAR, officeAssignedBy: ADMIN, entries: pastDuties(120, REGISTRAR), specialEvents: [] },
    { studentNumber: S[9].studentNumber, academicYear: 2025, term: '2nd Semester', officeAssigned: CICS, officeAssignedBy: ADMIN, entries: pastDuties(30, CICS), specialEvents: [] },
  ]);

  // This term's renewal: Angela (evaluated) already submitted her grades.
  const angelaLog = await DutyLog.findOne({ studentNumber: S[2].studentNumber, academicYear: 2026, term: '1st Semester' }).lean();
  await Renewal.create(await renewal(S[2], 'Under Evaluation', { gpa: 3.55, at: '2026-10-27', evaluation: angelaLog.evaluation }, nextPeriod));

  // Partner offices' scholarships opened by their offices (they start closed).
  await ScholarshipSetting.insertMany([
    { scholarshipId: 's11', status: 'Open', opensOn: '2026-11-03', closesOn: '2026-11-20', updatedBy: REVIEWERS.USG.email },
    { scholarshipId: 's13', status: 'Open', opensOn: '2026-11-01', closesOn: '2026-11-30', updatedBy: REVIEWERS.CBAASG.email },
    { scholarshipId: 's15', status: 'Open', opensOn: '2026-11-01', closesOn: '2026-12-31', updatedBy: REVIEWERS.CICSSG.email },
    { scholarshipId: 's16', status: 'Open', opensOn: '2026-11-02', closesOn: '2026-11-27', updatedBy: REVIEWERS.CEATSG.email },
    { scholarshipId: 's17', status: 'Open', opensOn: '2026-11-02', closesOn: '2026-11-25', updatedBy: REVIEWERS.CCJESG.email },
  ]);

  // Announcements
  const image = bannerPng();
  const imageId = await store.putFile({ buffer: image, filename: 'sfag-orientation.png', mimetype: 'image/png', metadata: { kind: 'announcement-image' } });
  await Announcement.insertMany([
    { title: 'SFAG Orientation for New Grantees', description: 'All new SFAG grantees must attend the orientation on August 14.', content: 'All new Student Financial Aid Grant grantees for A.Y. 2026–2027 must attend the orientation.\n\nDate: August 14, 2026\nTime: 1:00–4:00 PM\nVenue: Aklatang Emilio Aguinaldo, Audio-Visual Room\n\nDuty office assignments and the duty hours rules will be discussed.', category: 'Event', status: 'published', publishedAt: d('2026-08-01T09:00:00+08:00'), isPinned: true, scholarshipId: 's1', createdBy: ADMIN_NAME, images: [{ fileId: imageId, filename: 'sfag-orientation.png', mimetype: 'image/png' }] },
    { title: 'Renewal for the 2nd Semester is open', description: 'SFAG scholars: submit your grades until January 15, 2027.', content: 'The renewal for the 2nd semester of A.Y. 2026–2027 is now open for SFAG scholars.\n\nSubmit your GPA and your Certified True Copy of Grades (TCG) on the Renewal page until January 15, 2027. You can renew once your duty office has evaluated you for this semester.', category: 'Deadline', status: 'published', publishedAt: d('2026-10-26T09:00:00+08:00'), scholarshipId: 's1', createdBy: ADMIN_NAME },
    { title: 'Entrance Scholarship results are out', description: 'Check your application status on AniSkolar.', content: 'Results of the Entrance Scholarship for A.Y. 2026–2027 are now available. Check your application status on AniSkolar.', category: 'Update', status: 'published', publishedAt: d('2026-06-26T09:00:00+08:00'), scholarshipId: 's2', createdBy: ADMIN_NAME },
    { title: 'Christmas Outreach with COSA', description: 'Join COSA on December 5. Credited 3 duty hours.', content: 'COSA invites all scholars to the Christmas Outreach on December 5, 2026. Attendance is credited 3 duty hours (claim it on your Duty Hours page after the event).', category: 'Event', status: 'scheduled', scheduledFor: d('2026-11-20T09:00:00+08:00'), createdBy: ADMIN_NAME },
    { title: 'Draft: SFAG applications for A.Y. 2027–2028', description: 'Applications open in June 2027.', content: 'Draft — to be finalized with the office.', category: 'General', status: 'draft', createdBy: ADMIN_NAME },
    // A partner office's announcement waiting for the AdSO's approval.
    { title: 'Padayon Pioneers: interview schedules', description: 'Shortlisted applicants, check your DLSU-D email for your interview slot.', content: 'Shortlisted Padayon Pioneers applicants: your interview schedule has been sent to your DLSU-D email. To reschedule, tell the CICSSG at least one day before.\n\nVenue: PCH 102', category: 'Update', status: 'pending', office: 'CICSSG', scholarshipId: 's15', createdBy: REVIEWERS.CICSSG.name, review: { requestedStatus: 'published', requestedAt: d('2026-11-11T16:00:00+08:00'), requestedBy: REVIEWERS.CICSSG.email } },
    { title: 'CEAT Financial Aid: applications open', description: 'Apply until November 27. ₱200,000 set aside this semester.', content: 'The CEAT Financial Aid Scholarship is open until November 27, 2026. This semester\'s criteria (minimum GPA, failing units, unit load) are in the scholarship page.', category: 'Deadline', status: 'published', publishedAt: d('2026-11-02T09:00:00+08:00'), office: 'CEATSG', scholarshipId: 's16', createdBy: REVIEWERS.CEATSG.name, review: { decision: 'approved', decidedAt: d('2026-11-02T08:30:00+08:00'), decidedBy: ADMIN } },
  ]);

  // Messages with the AdSO: a finished exchange, an unread question with a
  // PDF, and one with the first real student.
  const msg = (s, from, at, body, extra = {}) => ({
    studentNumber: s.studentNumber, from, body, createdAt: d(at), updatedAt: d(at),
    authorName: from === 'adso' ? ADMIN_NAME : s.name, authorEmail: from === 'adso' ? ADMIN : s.email,
    readAt: extra.unread ? null : d(at), ...extra.more,
  });
  const sfagOf = sn => apps.find(a => a.studentNumber === sn && a.scholarshipId === 's1');
  const pdfFor = async (s, label) => (await docs([label], `${s.firstName} ${s.lastName}`))[0];
  const indigency = await pdfFor(S[2], 'Certificate of indigency (new copy)');
  await db.collection('messages').insertMany([
    { office: ACCOUNTING, from: 'office', authorName: `${headOf(ACCOUNTING)?.[0] ?? 'Head'} (Accounting Office)`, authorEmail: headOf(ACCOUNTING)?.[1], body: 'Good day! One of your scholars has been absent twice this week. Could you check with her?', attachments: [], readAt: null, createdAt: d('2026-10-16T14:20:00+08:00'), updatedAt: d('2026-10-16T14:20:00+08:00') },
  ]);
  await db.collection('messages').insertMany([
    msg(S[0], 'student', '2026-08-03T10:15:00+08:00', 'Good morning po! When is the orientation for new SFAG grantees?', { more: { applicationRef: sfagOf(S[0].studentNumber)?.referenceCode } }),
    msg(S[0], 'adso', '2026-08-03T13:40:00+08:00', 'Good afternoon! The orientation is on August 14, 1:00–4:00 PM at the Aklatang Emilio Aguinaldo AVR. Please bring your COR.'),
    msg(S[0], 'student', '2026-08-03T13:52:00+08:00', 'Noted po, thank you!'),
    msg(S[2], 'student', '2026-10-16T09:05:00+08:00', 'Hello po, here is a clearer copy of my certificate of indigency as requested.', { unread: true, more: { attachments: [{ fileId: indigency.fileId, filename: indigency.filename, mimetype: 'application/pdf', size: indigency.size }], applicationRef: sfagOf(S[2].studentNumber)?.referenceCode } }),
    msg(S[8], 'adso', '2026-07-12T10:00:00+08:00', 'Hi Jasmine, your SFAG application needs a clearer copy of your certificate of indigency. Please resubmit it on AniSkolar.', { unread: true }),
    msg(S[5], 'student', '2026-10-20T10:30:00+08:00', 'Correction request (Personal details):\nMy middle name is Tolentino, not Torres. I attached my PSA birth certificate in Messages.', { unread: true }),
    ...(realStudents[0] ? [msg(realStudents[0], 'adso', '2026-10-17T15:00:00+08:00', 'Hi! This is a sample message from the AdSO (demo data). You can reply here.', { unread: true })] : []),
  ]);

  // Per-office inboxes: each office talks with its own applicants.
  await db.collection('messages').insertMany([
    msg(S[15], 'adso', '2026-11-06T11:00:00+08:00', 'Hi Miguel! Your Padayon Pioneers interview is on November 18, 10:30 AM at PCH 102. Please bring your COR.', { more: { inbox: 'CICSSG', authorName: REVIEWERS.CICSSG.name, authorEmail: REVIEWERS.CICSSG.email } }),
    msg(S[15], 'student', '2026-11-06T12:10:00+08:00', 'Noted po, see you!', { more: { inbox: 'CICSSG' } }),
    msg(S[16], 'student', '2026-11-10T08:45:00+08:00', 'Good morning po! Is the Certificate of Tax Exemption required, or only if we have one?', { unread: true, more: { inbox: 'CBAASG' } }),
    msg(S[5], 'adso', '2026-11-07T09:30:00+08:00', 'Hi Paolo, the file you uploaded for the Certificate of Indigency is your COR. Please resubmit with the correct file.', { unread: true, more: { inbox: 'CCJESG', authorName: REVIEWERS.CCJESG.name, authorEmail: REVIEWERS.CCJESG.email } }),
  ]);

  // The AdSO's inbox: Maria's chat pinned, Jasmine's archived.
  await MessageThread.insertMany([
    { kind: 'student', key: S[0].studentNumber, pinnedAt: d('2026-10-01T09:00:00+08:00') },
    { kind: 'student', key: S[8].studentNumber, archivedAt: d('2026-07-13T09:00:00+08:00') },
  ]);

  const counts = {};
  for (const c of await db.listCollections().toArray()) counts[c.name] = await db.collection(c.name).countDocuments();
  console.log('Done:', counts);
  console.log(`Files in ${store.azureEnabled() ? 'Azure container aniskolar-demo' : 'GridFS'}.`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(async err => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
