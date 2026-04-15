const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');

/**
 * @param {object|null} bot - Bot instance.
 *   Pass the bot to enable the webhook endpoint (production mode).
 *   Pass null for polling/dev mode.
 */
function initServer(bot = null) {
  const app = express();
  const port = process.env.PORT || 5000;

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({
    secret: process.env.SESSION_SECRET || 'secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 3600000 },
  }));

  // ── Webhook endpoint (production) ───────────────────────────────────────
  // Telegram POSTs all incoming updates here.
  // We MUST respond 200 immediately — before processing — so Telegram
  // does not retry. Any thrown error still returns 200.
  if (bot) {
    app.post('/webhook', (req, res) => {
      res.sendStatus(200);
      console.log('[WEBHOOK] Update received:', JSON.stringify(req.body).slice(0, 120));
      try {
        if (req.body) bot.processUpdate(req.body);
      } catch (e) {
        console.error('[WEBHOOK ERROR]', e.message);
      }
    });
    console.log('[Server] Webhook endpoint registered: POST /webhook');
  }

  // ── Debug webhook info route ────────────────────────────────────────────
  // GET /debug-webhook → returns current Telegram webhook info as JSON
  app.get('/debug-webhook', async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
    }
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/getWebhookInfo`,
        { signal: AbortSignal.timeout(8000) }
      );
      const data = await response.json();
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  const isAuthenticated = (req, res, next) => {
    if (req.session.isAdmin) return next();
    res.redirect('/login');
  };

  app.get('/', (req, res) => {
    const mode = bot ? 'WEBHOOK' : 'POLLING';
    res.send(`✅ Bot is running! Mode: ${mode} | Go to <a href="/admin">/admin</a> for the dashboard.`);
  });

  app.get('/login', (req, res) => {
    res.render('login', { error: null });
  });

  app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_PASSWORD) {
      req.session.isAdmin = true;
      res.redirect('/admin');
    } else {
      res.render('login', { error: 'كلمة المرور غير صحيحة' });
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
  });

  app.get('/admin', isAuthenticated, async (req, res) => {
    try {
      const stats = await db.getStats();
      const history = await db.getHistory(100);
      res.render('admin', { stats, history });
    } catch (error) {
      console.error('[Server] Admin error:', error.message);
      res.status(500).send('Error loading dashboard');
    }
  });

  app.post('/admin/clear', isAuthenticated, async (req, res) => {
    try {
      await db.clearHistory();
      res.redirect('/admin');
    } catch (error) {
      res.status(500).send('Error clearing history');
    }
  });

  app.listen(port, () => {
    console.log(`[Server] Running on port ${port}`);
  });

  return app;
}

module.exports = initServer;
