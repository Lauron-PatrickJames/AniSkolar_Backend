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

const app = express(); // ✅ Create the app first

app.use(cors());
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

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'AniSkolar API is running' });
});

const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB Atlas connected');
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
  });