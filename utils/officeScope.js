// Per-office admin scoping. Every admin has an office, resolved from their
// Clerk publicMetadata in middleware/requireAdmin.js ('ADSO' in Clerk is
// stored as the code 'LSO').
//
// - POLCA / ALUMNI admins see every application tagged with their office,
//   and nothing else.
// - The AdSO ('LSO') sees its own applications plus whatever the other
//   offices have sent over with POST /api/applications/forward. Office
//   applications that haven't been sent yet stay with that office.
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
      { forwardedAt: { $ne: null } },
    ],
  };
}

module.exports = { scopedOffice, officeFilter };
