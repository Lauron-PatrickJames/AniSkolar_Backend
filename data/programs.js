// DLSU-D undergraduate programs: code -> course name and college. The
// student profile stores the code and takes course and college from here.
// Mirrors src/data/programs.ts in the frontend — keep the two in sync.
// Source: the DLSU-D "All Programs" page (see the frontend file).

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
  ['BSA', 'Bachelor of Science in Accountancy', 'CBAA'],
  ['BSMA', 'Bachelor of Science in Management Accounting', 'CBAA'],
  ['BSEntrep', 'Bachelor of Science in Entrepreneurship', 'CBAA'],
  ['BSBA-BOM', 'BSBA Major in Business and Operations Management', 'CBAA'],
  ['BSBA-BE', 'BSBA Major in Business Economics', 'CBAA'],
  ['BSBA-HRD', 'BSBA Major in Human Resource Development', 'CBAA'],
  ['BSBA-MM', 'BSBA Major in Marketing Management', 'CBAA'],
  ['BSBA-MM-IMC', 'BSBA Major in Marketing Management with Specialization in Integrated Marketing Communications', 'CBAA'],
  ['BSCrim', 'Bachelor of Science in Criminology', 'CCJE'],
  ['BFS', 'Bachelor of Forensic Science', 'CCJE'],
  ['BSArch', 'Bachelor of Science in Architecture', 'CEAT'],
  ['BSCE', 'Bachelor of Science in Civil Engineering', 'CEAT'],
  ['BSCpE', 'Bachelor of Science in Computer Engineering', 'CEAT'],
  ['BSEE', 'Bachelor of Science in Electrical Engineering', 'CEAT'],
  ['BSECE', 'Bachelor of Science in Electronics Engineering', 'CEAT'],
  ['BSIE', 'Bachelor of Science in Industrial Engineering', 'CEAT'],
  ['BSME', 'Bachelor of Science in Mechanical Engineering', 'CEAT'],
  ['BSEnSE', 'Bachelor of Science in Environmental and Sanitary Engineering', 'CEAT'],
  ['BMMA', 'Bachelor of Multimedia Arts', 'CEAT'],
  ['BSCS', 'Bachelor of Science in Computer Science', 'CICS'],
  ['BSIT', 'Bachelor of Science in Information Technology', 'CICS'],
  ['ABComm', 'Bachelor of Arts in Communication', 'CLAC'],
  ['ABDMJ', 'Bachelor of Arts in Digital and Multimedia Journalism', 'CLAC'],
  ['ABID', 'Bachelor of Arts in International Development', 'CLAC'],
  ['ABPolSci', 'Bachelor of Arts in Political Science', 'CLAC'],
  ['ABPsych', 'Bachelor of Arts in Psychology', 'CLAC'],
  ['BSPsych', 'Bachelor of Science in Psychology', 'CLAC'],
  ['BECEd', 'Bachelor of Early Childhood Education', 'COEd'],
  ['BSNEd', 'Bachelor of Special Needs Education', 'COEd'],
  ['BSEd-Eng', 'Bachelor of Secondary Education major in English', 'COEd'],
  ['BSEd-Fil', 'Bachelor of Secondary Education major in Filipino', 'COEd'],
  ['BSEd-Math', 'Bachelor of Secondary Education major in Mathematics', 'COEd'],
  ['BSEd-Sci', 'Bachelor of Secondary Education major in Science', 'COEd'],
  ['BSEd-SS', 'Bachelor of Secondary Education major in Social Studies', 'COEd'],
  ['BSBio', 'Bachelor of Science in Biology', 'COS'],
  ['BSAM', 'Bachelor of Science in Applied Mathematics', 'COS'],
  ['BSITM', 'Bachelor of Science in International Tourism Management', 'CTHM'],
  ['BSIHM', 'BS International Hospitality Management with Specialization in Culinary & Food Service Administration', 'CTHM'],
].map(([code, name, college]) => ({ code, name, college }));

function findProgram(code) {
  if (typeof code !== 'string' || !code.trim()) return undefined;
  const c = code.trim().toLowerCase();
  return PROGRAMS.find(p => p.code.toLowerCase() === c);
}

const YEAR_LEVELS = ['1st Year', '2nd Year', '3rd Year', '4th Year', '5th Year'];

module.exports = { COLLEGES, PROGRAMS, findProgram, YEAR_LEVELS };
