// Per-office admin scoping. An admin's office comes from their Clerk
// publicMetadata ({ role: 'admin', office: 'POLCA' }), read in
// middleware/requireAdmin.js.
//
// - POLCA / ALUMNI admins see every application tagged with their office,
//   and nothing else. An unrecognised office value matches nothing
//   (fails closed).
// - The LSO (office 'LSO', or no office at all — every admin provisioned
//   before offices existed) sees its own applications plus whatever the
//   other offices have sent over with POST /api/applications/forward.
//   Office applications that haven't been sent yet stay with that office.

function scopedOffice(adminUser) {
  const office = adminUser?.office;
  if (!office || office === 'LSO') return null;
  return office;
}

// Mongo filter fragment to merge into any admin-side application query.
// Applications created before offices existed have no office field and
// count as LSO's (office: null also matches a missing field).
function officeFilter(adminUser) {
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
