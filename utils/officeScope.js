// Per-office admin scoping. An admin's office comes from their Clerk
// publicMetadata ({ role: 'admin', office: 'POLCA' }), read in
// middleware/requireAdmin.js. The LSO is the central scholarship office,
// so an admin with office 'LSO' — or no office at all, which is every
// admin provisioned before offices existed — sees every application.
// Any other office only sees applications tagged with that office; an
// unrecognised office value matches nothing (fails closed).

function scopedOffice(adminUser) {
  const office = adminUser?.office;
  if (!office || office === 'LSO') return null;
  return office;
}

// Mongo filter fragment to merge into any admin-side application query.
function officeFilter(adminUser) {
  const office = scopedOffice(adminUser);
  return office ? { office } : {};
}

module.exports = { scopedOffice, officeFilter };
