const { getAuth, clerkClient } = require('@clerk/express');
const { officeForHead } = require('../utils/offices');

// The head of a duty office (listed by the AdSO in Duty hours → Offices),
// signed in with that school email. Sets req.officeHead = { office, name,
// email }. 401 signed out; 403 when the account isn't an office head.
async function requireOfficeHead(req, res, next) {
  try {
    const { userId } = getAuth(req) || {};
    if (!userId) return res.status(401).json({ error: 'Not authenticated.' });
    const user = await clerkClient.users.getUser(userId);
    const primary = user.emailAddresses?.find(e => e.id === user.primaryEmailAddressId) ?? user.emailAddresses?.[0];
    const office = await officeForHead(primary?.emailAddress);
    if (!office) return res.status(403).json({ error: "This account isn't the head of a duty office in AniSkolar." });
    req.officeHead = { office: office.office, name: office.headName || [user.firstName, user.lastName].filter(Boolean).join(' '), email: office.headEmail };
    next();
  } catch (err) {
    console.error('Office head check failed:', err);
    res.status(500).json({ error: 'Failed to verify your account.' });
  }
}

module.exports = { requireOfficeHead };
