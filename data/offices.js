// The offices that run scholarships in AniSkolar. Each has its own admin
// accounts (Clerk publicMetadata: { role: 'admin', office: '<clerk>' }) and
// handles its scholarships entirely: opening and closing them, deciding the
// applications, renewals. The AdSO ('LSO') runs its own scholarships and
// sees every other office's approved scholars, read-only.
// Mirrors OFFICES in the frontend's src/data/scholarships.ts.

const OFFICES = [
  { code: 'LSO', clerk: 'ADSO', name: 'Admissions and Scholarship Office (AdSO)', short: 'AdSO' },
  { code: 'POLCA', name: 'POLCA Office', short: 'POLCA' },
  { code: 'ALUMNI', name: 'Alumni Office', short: 'Alumni Office' },
  { code: 'SDO', name: 'Sports Development Office (SDO)', short: 'SDO' },
  { code: 'VICISSITUDE', name: 'Vicissitude', short: 'Vicissitude' },
  { code: 'ROTC', name: 'ROTC Office (267th NROTCU)', short: 'ROTC' },
  { code: 'USG', name: 'University Student Government (USG)', short: 'USG' },
  { code: 'HERALDO', name: 'Heraldo Filipino', short: 'Heraldo Filipino' },
  { code: 'CICSSG', name: 'CICS Student Government', short: 'CICSSG' },
  { code: 'CBAASG', name: 'CBAA Student Government', short: 'CBAASG' },
  { code: 'COEDSG', name: 'COEd Student Government', short: 'COEDSG' },
  { code: 'CCJESG', name: 'CCJE Student Government', short: 'CCJESG' },
  { code: 'CEATSG', name: 'CEAT Student Government', short: 'CEATSG' },
  { code: 'CTHMSG', name: 'CTHM Student Government', short: 'CTHMSG' },
  { code: 'COSSG', name: 'COS Student Government', short: 'COSSG' },
];

const OFFICE_CODES = OFFICES.map(o => o.code);
const OFFICE_NAMES = Object.fromEntries(OFFICES.map(o => [o.code, o.name]));
// Clerk metadata value -> office code ('ADSO' is stored as 'LSO').
const CLERK_OFFICES = Object.fromEntries(OFFICES.map(o => [o.clerk ?? o.code, o.code]));

module.exports = { OFFICES, OFFICE_CODES, OFFICE_NAMES, CLERK_OFFICES };
