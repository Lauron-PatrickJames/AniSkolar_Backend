// DLSU-D undergraduate programs: code -> course name and college. The
// student profile stores the code and takes course and college from here.
// Mirrors src/data/programs.ts in the frontend — keep the two in sync.
// TO CONFIRM with the Registrar / AdSO (see the frontend file).

const COLLEGES = {
  CBAA: 'College of Business Administration and Accountancy',
  CCJE: 'College of Criminal Justice Education',
  CEAT: 'College of Engineering, Architecture and Technology',
  CICS: 'College of Information and Computer Studies',
  CLAC: 'College of Liberal Arts and Communication',
  COEd: 'College of Education',
  COS: 'College of Science',
  CTHM: 'College of Tourism and Hospitality Management',
};

const PROGRAMS = [
  ['BSA', 'BS Accountancy', 'CBAA'],
  ['BSMA', 'BS Management Accounting', 'CBAA'],
  ['BSBA-FM', 'BS Business Administration major in Financial Management', 'CBAA'],
  ['BSBA-HRM', 'BS Business Administration major in Human Resource Management', 'CBAA'],
  ['BSBA-MM', 'BS Business Administration major in Marketing Management', 'CBAA'],
  ['BSBA-OM', 'BS Business Administration major in Operations Management', 'CBAA'],
  ['BSEntrep', 'BS Entrepreneurship', 'CBAA'],
  ['BSCrim', 'BS Criminology', 'CCJE'],
  ['BSArch', 'BS Architecture', 'CEAT'],
  ['BSCE', 'BS Civil Engineering', 'CEAT'],
  ['BSCpE', 'BS Computer Engineering', 'CEAT'],
  ['BSEE', 'BS Electrical Engineering', 'CEAT'],
  ['BSECE', 'BS Electronics Engineering', 'CEAT'],
  ['BSIE', 'BS Industrial Engineering', 'CEAT'],
  ['BSME', 'BS Mechanical Engineering', 'CEAT'],
  ['BSCS', 'BS Computer Science', 'CICS'],
  ['BSIT', 'BS Information Technology', 'CICS'],
  ['ABComm', 'AB Communication', 'CLAC'],
  ['ABPhilo', 'AB Philosophy', 'CLAC'],
  ['ABPolSci', 'AB Political Science', 'CLAC'],
  ['BMMA', 'Bachelor of Multimedia Arts', 'CLAC'],
  ['BSPsych', 'BS Psychology', 'CLAC'],
  ['BEEd', 'Bachelor of Elementary Education', 'COEd'],
  ['BPEd', 'Bachelor of Physical Education', 'COEd'],
  ['BSEd-Eng', 'Bachelor of Secondary Education major in English', 'COEd'],
  ['BSEd-Fil', 'Bachelor of Secondary Education major in Filipino', 'COEd'],
  ['BSEd-Math', 'Bachelor of Secondary Education major in Mathematics', 'COEd'],
  ['BSEd-Sci', 'Bachelor of Secondary Education major in Science', 'COEd'],
  ['BSEd-SS', 'Bachelor of Secondary Education major in Social Studies', 'COEd'],
  ['BSBio', 'BS Biology', 'COS'],
  ['BSChem', 'BS Chemistry', 'COS'],
  ['BSMath', 'BS Mathematics', 'COS'],
  ['BSHM', 'BS Hospitality Management', 'CTHM'],
  ['BSTM', 'BS Tourism Management', 'CTHM'],
].map(([code, name, college]) => ({ code, name, college }));

function findProgram(code) {
  if (typeof code !== 'string' || !code.trim()) return undefined;
  const c = code.trim().toLowerCase();
  return PROGRAMS.find(p => p.code.toLowerCase() === c);
}

const YEAR_LEVELS = ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year'];

module.exports = { COLLEGES, PROGRAMS, findProgram, YEAR_LEVELS };
