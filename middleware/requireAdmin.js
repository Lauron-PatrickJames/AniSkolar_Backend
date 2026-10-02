const { getAuth, clerkClient } = require('@clerk/express');

// Admin accounts are provisioned manually (Clerk Dashboard or a seed
// script) — see LoginPage.tsx. They authenticate with email+password and
// deliberately have no Student document at all, so "is this user an
// admin" can't be answered from Mongo the way student identity can.
// Instead we check Clerk's own publicMetadata, set once at provisioning
// time: { role: "admin", office: "<OFFICE>" }.
//
// Every admin must belong to an office:
//   { "role": "admin", "office": "ADSO" }    // Admissions and Scholarship Office
//   { "role": "admin", "office": "POLCA" }
//   { "role": "admin", "office": "ALUMNI" }
// An admin with no office, or one not listed here, is refused (403).
//
// To provision an admin: in the Clerk Dashboard, open the user (or create
// one), go to Metadata, and add the public metadata above. Or via a seed
// script:
//   await clerkClient.users.updateUserMetadata(userId, { publicMetadata: { role: 'admin', office: 'ADSO' } });

// Clerk metadata value -> office code stored on applications. The AdSO is
// stored as 'LSO' (its code from before the rename), so existing records
// need no migration.
const ADMIN_OFFICES = { ADSO: 'LSO', POLCA: 'POLCA', ALUMNI: 'ALUMNI' };
async function requireAdmin(req, res, next) {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const user = await clerkClient.users.getUser(userId);
    if (user.publicMetadata?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    // publicMetadata.office decides which applications this admin can see
    // — see utils/officeScope.js.
    const requested = typeof user.publicMetadata?.office === 'string'
      ? user.publicMetadata.office.trim().toUpperCase()
      : '';
    const office = ADMIN_OFFICES[requested];
    if (!office) {
      return res.status(403).json({
        error: 'This admin account isn\'t assigned to an office. Ask a system administrator to set its office (ADSO, POLCA or ALUMNI) in Clerk.',
      });
    }

    // Display name for history entries ("POLCA Office · Maria Santos").
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || undefined;
    req.adminUser = { id: userId, email: user.emailAddresses?.[0]?.emailAddress, name, office };
    next();
  } catch (err) {
    console.error('requireAdmin check failed:', err);
    res.status(500).json({ error: 'Failed to verify admin access.' });
  }
}

// AdSO admins only (office 'ADSO' in Clerk, stored as 'LSO'). Used for
// features that belong to the AdSO alone, like announcements.
function requireAdsoOnly(req, res, next) {
  if (req.adminUser?.office !== 'LSO') {
    return res.status(403).json({ error: 'Only the Admissions and Scholarship Office (AdSO) can do this.' });
  }
  next();
}
const requireAdso = [requireAdmin, requireAdsoOnly];

module.exports = { requireAdmin, requireAdso, ADMIN_OFFICES };