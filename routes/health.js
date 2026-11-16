const express = require('express');
const mongoose = require('mongoose');

// GET /api/health, for the uptime monitor: 200 only when the database
// answers a ping, 503 otherwise (e.g. a wrong or rotated password). No
// sign-in needed, and nothing about the setup is revealed.
// `connection` is replaceable for tests (default: mongoose's).
function healthRouter(connection = mongoose.connection) {
  const router = express.Router();
  router.get('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (connection.readyState !== 1) throw new Error('not connected');
      // A ping that gives up after 5 s, so the monitor isn't left waiting.
      await Promise.race([
        connection.db.admin().ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
      res.json({ ok: true, database: 'up' });
    } catch {
      res.status(503).json({ ok: false, database: 'down' });
    }
  });
  return router;
}

module.exports = healthRouter;
