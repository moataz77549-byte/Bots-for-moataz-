require('dotenv').config();

const { loadEnv } = require('./config/envLoader');
const initBot     = require('./bot');
const initServer  = require('./server');
const keepAlive   = require('./keepAlive');

/**
 * Application entry point and supervisor for the Telegram downloader bot.
 *
 * This file orchestrates the bot lifecycle, including graceful shutdown,
 * webhook registration, health logging and fallback to polling mode.
 *
 * It has been refactored to remove Replit‑specific logic in favour of
 * generic environment variables that work on platforms such as Railway
 * and Render. To control the deployment mode set the following variables:
 *   - USE_WEBHOOK=true     — Enable webhook mode (default is polling)
 *   - WEBHOOK_URL=https://your.domain.com/webhook  — Full URL for Telegram
 *   - PORT=5000            — HTTP server port for health checks / webhook
 *   - BOT_DISABLED=true    — Start HTTP server only (no Telegram session)
 */

// ─────────────────────────────────────────
// Global safety net
// ─────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[App] ⚠️  Uncaught exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[App] ⚠️  Unhandled rejection:', reason?.message || reason);
});

// ─────────────────────────────────────────
// Graceful shutdown on SIGTERM / SIGINT
// (prevents stale zombie processes on workflow restart)
// ─────────────────────────────────────────
async function gracefulShutdown(signal) {
  console.log(`[App] ${signal} received — shutting down gracefully...`);
  if (currentBot) {
    try { await currentBot.stopPolling(); } catch (_) {}
  }
  console.log('[App] Bye.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ─────────────────────────────────────────
// Resolve the webhook URL when running in webhook mode. This helper
// chooses the URL from the environment rather than relying on
// Replit‑specific variables. Set WEBHOOK_URL to the full HTTPS URL
// pointing at your /webhook endpoint. If not provided and USE_WEBHOOK
// is falsey, polling mode will be used.
// ─────────────────────────────────────────
function resolveWebhookUrl() {
  const url = (process.env.WEBHOOK_URL || '').trim();
  if (!url) return null;
  return url.replace(/\s+/g, '');
}

// ─────────────────────────────────────────
// Self-ping keep-alive (dev only)
// ─────────────────────────────────────────
function startKeepAlive() {
  // Self‑ping mechanism to prevent certain free hosting plans from
  // idling out. This is optional and should not be relied upon for
  // production availability. Provide KEEPALIVE_URL (or reuse WEBHOOK_URL)
  // to enable it. When undefined the pinger is disabled.
  const url = (process.env.KEEPALIVE_URL || process.env.WEBHOOK_URL || '').trim();
  if (!url) {
    console.log('[KeepAlive] No KEEPALIVE_URL set — self‑ping disabled');
    return;
  }
  const INTERVAL_MS = 3 * 60 * 1000;
  setInterval(async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      console.log(`[KeepAlive] Ping OK — ${res.status} — ${new Date().toISOString()}`);
    } catch (err) {
      console.warn(`[KeepAlive] Ping failed: ${err.message}`);
    }
  }, INTERVAL_MS);
  console.log(`[KeepAlive] Self‑ping active → ${url} every 3 min`);
}

// ─────────────────────────────────────────
// Health logger
// ─────────────────────────────────────────
function startHealthLogger() {
  const startTime = Date.now();
  let downloadQueue;
  try { downloadQueue = require('./queue'); } catch (_) {}

  setInterval(() => {
    const queueInfo = downloadQueue
      ? ` | Queue: ${downloadQueue.activeCount} active, ${downloadQueue.waitingCount} waiting`
      : '';
    console.log(`[HEALTH] Bot running at ${new Date().toISOString()}${queueInfo}`);
  }, 60 * 1000);

  setInterval(() => {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const hours     = Math.floor(uptimeSec / 3600);
    const minutes   = Math.floor((uptimeSec % 3600) / 60);
    const memMB     = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    console.log(`[HEALTH] ✅ Uptime: ${hours}h ${minutes}m | Memory: ${memMB}MB`);
  }, 30 * 60 * 1000);
}

// ─────────────────────────────────────────
// Steal competing polling session (dev mode only)
//
// NOTE: We do NOT call deleteWebhook here.
// If the production instance has set a webhook, we must not delete it.
// We only send a zero-timeout getUpdates to evict any other *polling* session.
// ─────────────────────────────────────────
async function stealPollingSession(token) {
  const base = `https://api.telegram.org/bot${token}`;
  try {
    const res = await fetch(`${base}/getUpdates?timeout=0&limit=1&offset=-1`,
      { signal: AbortSignal.timeout(8000) });
    const json = await res.json().catch(() => ({}));

    if (json.ok === false && json.description && json.description.includes('webhook')) {
      console.warn('[App] ⚠️  Webhook is active on this token (set by production).');
      console.warn('[App]     Dev polling will receive 409s. Set BOT_DISABLED=true to silence dev,');
      console.warn('[App]     or ensure production is using webhooks and not competing.');
      return false; // webhook is active — polling won't work
    }

    console.log('[App] Session steal — OK (competing poller terminated)');
    return true;
  } catch (e) {
    console.warn('[App] Session steal failed:', e.message);
    return true; // proceed anyway
  }
}

// ─────────────────────────────────────────
// Bot restart loop (polling mode only)
// ─────────────────────────────────────────
let currentBot   = null;
let restartCount = 0;
const SCHEDULED_RESTART_MS = 24 * 60 * 60 * 1000;

async function startBotLoop(token) {
  while (true) {
    restartCount++;
    try {
      if (restartCount > 1) {
        console.log(`[App] 🔄 Bot restart #${restartCount}`);
      }

      if (currentBot) {
        try { await currentBot.stopPolling(); } catch (_) {}
        currentBot = null;
      }

      if (restartCount > 1) {
        await stealPollingSession(token);
        await new Promise(r => setTimeout(r, 2000));
      }

      currentBot = initBot({ webhookMode: false });

      if (!currentBot) {
        console.error('[App] Bot could not start. Check TELEGRAM_BOT_TOKEN.');
        break;
      }

      await new Promise(resolve => {
        const timer = setTimeout(() => {
          console.log('[App] ⏰ Scheduled 24h restart...');
          resolve();
        }, SCHEDULED_RESTART_MS);

        currentBot.once('_restart', () => {
          clearTimeout(timer);
          resolve();
        });
      });

    } catch (err) {
      console.error(`[App] Bot loop error: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─────────────────────────────────────────
// Production: register webhook with Telegram
// ─────────────────────────────────────────
async function registerWebhook(token, webhookUrl) {
  console.log(`[WEBHOOK] Setting webhook: ${webhookUrl}`);

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          max_connections: 40,
          allowed_updates: ['message', 'callback_query', 'inline_query'],
        }),
        signal: AbortSignal.timeout(10000),
      }
    );
    const data = await res.json();
    console.log('[WEBHOOK] Response:', JSON.stringify(data));

    if (data.ok) {
      console.log('[WEBHOOK] ✅ Webhook registered successfully');
    } else {
      console.error('[WEBHOOK] ❌ Failed to register webhook:', data.description);
    }

    return data.ok;
  } catch (e) {
    console.error('[WEBHOOK] ❌ setWebhook request failed:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────
// Get current webhook info
// ─────────────────────────────────────────
async function getWebhookInfo(token) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getWebhookInfo`,
      { signal: AbortSignal.timeout(8000) }
    );
    return await res.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────
async function main() {
  console.log('[App] ═══════════════════════════════════');
  console.log('[App] Starting Video Downloader Bot...');
  console.log('[App] ═══════════════════════════════════');

  // ── Token validation ─────────────────
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !token.trim()) {
    console.error('[ENV] ❌ TELEGRAM_BOT_TOKEN is missing or empty.');
    console.error('[ENV]    Set it in the Secrets panel and restart.');
    return;
  }
  console.log('[ENV] ✅ TELEGRAM_BOT_TOKEN present');

  // ── BOT_DISABLED flag ────────────────
  if (process.env.BOT_DISABLED === 'true') {
    console.log('[App] ⚠️  BOT_DISABLED=true — HTTP server only, no bot.');
    const app = initServer(null);
    keepAlive(app);
    return;
  }

  // Load proxy + cookie config
  loadEnv();

  const { validateDependencies } = require('./downloader');
  validateDependencies();

  // ── Determine mode (webhook vs polling) ───────────────────────────────
  // USE_WEBHOOK=true will force webhook mode as long as WEBHOOK_URL is set.
  // Otherwise polling mode is used by default.
  const webhookUrl = resolveWebhookUrl();
  const useWebhook = /^true$/i.test(process.env.USE_WEBHOOK || '') && webhookUrl;

  console.log(`[App] Mode: ${useWebhook ? 'WEBHOOK' : 'POLLING'}`);
  startHealthLogger();

  if (useWebhook) {
    // ── WEBHOOK mode ───────────────────────────────────────────────────────
    console.log('[App] Starting in WEBHOOK mode...');

    // Initialise bot without polling
    const bot = initBot({ webhookMode: true });
    if (!bot) return;

    // Create HTTP server and health endpoints
    const app = initServer(bot);
    keepAlive(app);

    // Register webhook with Telegram
    const ok = await registerWebhook(token, webhookUrl);

    if (ok) {
      // Log confirmed webhook state
      await new Promise(r => setTimeout(r, 1000));
      const info = await getWebhookInfo(token);
      if (info.ok && info.result) {
        const r = info.result;
        console.log(`[WEBHOOK] Active URL: ${r.url}`);
        console.log(`[WEBHOOK] Pending updates: ${r.pending_update_count}`);
        if (r.last_error_message) {
          console.warn(`[WEBHOOK] ⚠️  Last delivery error: ${r.last_error_message}`);
        }
      }
    } else {
      console.warn('[App] ⚠️  Webhook setup failed — falling back to polling');
      await startBotLoop(token);
    }

  } else {
    // ── POLLING mode ───────────────────────────────────────────────────────
    console.log('[App] Starting in POLLING mode...');
    const app = initServer(null);
    keepAlive(app);
    await startBotLoop(token);
  }
}

main().catch((err) => {
  console.error('[App] Fatal startup error:', err.message);
  process.exit(1);
});
