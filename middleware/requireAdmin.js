const { getAuth, clerkClient } = require('@clerk/express');

// Admin accounts are provisioned manually (Clerk Dashboard or a seed
// script) — see LoginPage.tsx. They authenticate with email+password and
// deliberately have no Student document at all, so "is this user an
// admin" can't be answered from Mongo the way student identity can.
// Instead we check Clerk's own publicMetadata, set once at provisioning
// time: { role: "admin" }.
//
// To provision an admin: in the Clerk Dashboard, open the user (or create
// one), go to Metadata, and add public metadata { "role": "admin" }.
// Or via a seed script:
//   await clerkClient.users.updateUserMetadata(userId, { publicMetadata: { role: 'admin' } });
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

    req.adminUser = { id: userId, email: user.emailAddresses?.[0]?.emailAddress };
    next();
  } catch (err) {
    console.error('requireAdmin check failed:', err);
    res.status(500).json({ error: 'Failed to verify admin access.' });
  }
}

module.exports = { requireAdmin };