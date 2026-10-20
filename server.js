// Fix for Node's SRV DNS lookup failing on some networks (e.g. Globe Broadband)
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const { clerkMiddleware, getAuth } = require('@clerk/express');

const applicationRoutes = require('./routes/applications');
const studentRoutes = require('./routes/students');
const applicationDraftRoutes = require('./routes/applicationDrafts');
const announcementRoutes = require('./routes/announcements');
const scholarshipRoutes = require('./routes/scholarships');
const fseRoutes = require('./routes/fse');
const renewalRoutes = require('./routes/renewals');
const dutyHoursRoutes = require('./routes/dutyHours');
const messageRoutes = require('./routes/messages');
const officeRoutes = require('./routes/office');
const automationRoutes = require('./routes/automation');
const replyTemplateRoutes = require('./routes/replyTemplates');
const documentZipRoutes = require('./routes/documentZips');

const app = express(); // ✅ Create the app first

app.use(cors());
// An FSE report carries one row per scholar (~1,000 a term), more than the
// default 100 KB body limit; this parser runs first for that route only.
app.use('/api/fse', express.json({ limit: '5mb' }));
app.use(express.json());

// Populates req.auth on every request based on the caller's Clerk session
// token (if any) — routes that require it call requireAuth() themselves.
// Needs CLERK_SECRET_KEY (and CLERK_PUBLISHABLE_KEY) in your .env.
app.use(clerkMiddleware());

// Basic non-breaking CSRF mitigation for JSON API endpoints:
// 1) Require an authenticated Clerk session for mutating HTTP methods (POST, PUT, PATCH, DELETE).
// 2) If an Origin or Referer header is present, verify it matches allowed frontend origins.
// Configure allowed origins with the FRONTEND_ORIGINS environment variable as a comma-separated list
// (defaults to http://localhost:3000).
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || 'http://localhost:3000').split(',');
app.use((req, res, next) => {
  // Skip checks for safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // Ensure the caller is authenticated via Clerk
  const { userId } = getAuth(req) || {};
  if (!userId) return res.status(401).json({ error: 'Not authenticated.' });

  // If origin/referrer is set, enforce it matches an allowed origin
  const origin = req.get('origin') || req.get('referer') || '';
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!FRONTEND_ORIGINS.includes(parsed.origin)) {
        return res.status(403).json({ error: 'Invalid request origin.' });
      }
    } catch (err) {
      return res.status(400).json({ error: 'Malformed origin header.' });
    }
  }

  next();
});

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/students', studentRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/application-drafts', applicationDraftRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/scholarships', scholarshipRoutes);
app.use('/api/fse', fseRoutes);
app.use('/api/renewals', renewalRoutes);
app.use('/api/duty-hours', dutyHoursRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/office', officeRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/reply-templates', replyTemplateRoutes);
app.use('/api/documents', documentZipRoutes);
// Same router under /api/admin, e.g. POST /api/admin/announcements/:id/facebook/retry.
app.use('/api/admin/announcements', announcementRoutes);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'AniSkolar API is running' });
});

const PORT = process.env.PORT || 5000;

// MONGODB_DB (optional) picks another database on the same cluster, e.g.
// one for testing.
mongoose.connect(process.env.MONGODB_URI, process.env.MONGODB_DB ? { dbName: process.env.MONGODB_DB } : {})
  .then(async () => {
    console.log(`✅ MongoDB Atlas connected (${mongoose.connection.db.databaseName})`);
    // Scholarships the AdSO created (kept in memory for findScholarship),
    // loaded before the first request.
    await require('./utils/customScholarships').load()
      .catch(err => console.error('Loading created scholarships failed:', err));
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
    // Scheduled announcements: publish any that are due, now and every minute.
    const publishDue = () => announcementRoutes.publishDueAnnouncements()
      .catch(err => console.error('Publishing scheduled announcements failed:', err));
    publishDue();
    setInterval(publishDue, 60_000);
    // Announcement emails (Outlook) go out a few batches a minute.
    const sendEmails = () => announcementRoutes.processEmailQueue()
      .catch(err => console.error('Sending announcement emails failed:', err));
    setInterval(sendEmails, 60_000);
    // Reminders, summaries and the term rollover (Automation page), and the
    // outbox they queue personal emails in.
    const { runDueJobs } = require('./utils/automation');
    const { processOutbox } = require('./utils/outbox');
    const runJobs = () => runDueJobs().catch(err => console.error('Automation failed:', err));
    setTimeout(runJobs, 30_000);
    setInterval(runJobs, 15 * 60_000);
    setInterval(() => processOutbox().catch(err => console.error('Sending queued emails failed:', err)), 60_000);
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
  });