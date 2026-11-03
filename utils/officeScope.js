// Per-office admin scoping. Every admin has an office, resolved from their
// Clerk publicMetadata in middleware/requireAdmin.js ('ADSO' in Clerk is
// stored as the code 'LSO').
//
// - POLCA / ALUMNI admins see every application tagged with their office,
//   and nothing else.
// - The AdSO ('LSO') sees its own applications, and of an office's
//   applications only the approved ones, read-only: the office handles its
//   scholarships entirely (applications, decisions, graduated / stopped).
// - An admin without an office matches nothing (fails closed);
//   requireAdmin already refuses them, this is a second line of defence.

function scopedOffice(adminUser) {
  const office = adminUser?.office;
  if (office === 'LSO') return null;
  return office;
}

// Mongo filter fragment to merge into any admin-side application query.
// Applications created before offices existed have no office field and
// count as LSO's (office: null also matches a missing field).
function officeFilter(adminUser) {
  if (!adminUser?.office) return { _id: { $exists: false } };
  const office = scopedOffice(adminUser);
  if (office) return { office };
  return {
    $or: [
      { office: { $in: ['LSO', null] } },
      { office: { $nin: ['LSO', null] }, status: 'Approved' },
    ],
  };
}

const { OFFICE_NAMES } = require('../data/offices');

// The AdSO looking at an office's application: only that office can change
// it. Returns the reason, or null.
function partnerLock(adminUser, application) {
  if (scopedOffice(adminUser) || !application?.office || application.office === 'LSO') return null;
  return `The ${OFFICE_NAMES[application.office] ?? application.office} handles this scholarship, so only they can change its applications.`;
}

module.exports = { scopedOffice, officeFilter, partnerLock, OFFICE_NAMES };
