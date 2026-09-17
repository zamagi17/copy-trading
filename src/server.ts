import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import url from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { engine } from './services/engine';
import { scraper } from './services/scraper';
import { binanceClient } from './services/binance';
import { AuthService } from './services/auth';
import { telegramService } from './services/telegram';
import { UserPosition, BalanceInfo } from './types';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// WebSocket handling with Authentication
const clients = new Set<WebSocket>();

wss.on('connection', (ws, req) => {
  const reqUrl = url.parse(req.url || '', true);
  const token = reqUrl.query.token as string;
  const secret = engine.getConfig().jwtSecret || 'copytrader_secret';

  // Verifikasi token JWT
  const user = AuthService.verifyToken(token, secret);
  if (!user) {
    ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Unauthorized WebSocket' }));
    ws.close(4001, 'Unauthorized');
    return;
  }

  (ws as any).isAlive = true;
  ws.on('pong', () => {
    (ws as any).isAlive = true;
  });

  clients.add(ws);

  const cfg = engine.getConfig();
  let initUserBalance: BalanceInfo;
  let initUserPositions: UserPosition[] = [];

  if (cfg.paperTrading) {
    let totalUnrealizedProfit = 0;
    let usedMargin = 0;
    for (const vp of engine.virtualPositions.values()) {
      totalUnrealizedProfit += (vp.unRealizedProfit || 0);
      usedMargin += ((Math.abs(vp.positionAmt) * (vp.entryPrice || 0)) / (vp.leverage || 10));
    }
    initUserBalance = {
      totalWalletBalance: engine.virtualWalletBalance,
      totalUnrealizedProfit,
      totalMarginBalance: engine.virtualWalletBalance + totalUnrealizedProfit,
      availableBalance: Math.max(0, engine.virtualWalletBalance - usedMargin),
    };
    initUserPositions = engine.getVirtualPositions();
  } else {
    const cached = engine.getLastUserAccount();
    initUserBalance = cached.balance || {
      totalWalletBalance: 0,
      totalUnrealizedProfit: 0,
      totalMarginBalance: 0,
      availableBalance: 0,
    };
    initUserPositions = cached.positions || [];
  }

  // Kirim data awal saat connect
  ws.send(JSON.stringify({
    type: 'INIT',
    payload: {
      status: engine.getStatus(),
      config: maskConfig(cfg),
      leader: engine.getLastLeaderDetail(),
      user: {
        balance: initUserBalance,
        positions: initUserPositions,
        closedTrades: engine.getClosedTrades(),
      },
      logs: engine.getLogs(),
    }
  }));

  ws.on('close', () => {
    clients.delete(ws);
  });
});

// Periodic ping to keep connections alive and prevent 20-minute idle timeouts
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws: any) => {
    if (ws.isAlive === false) {
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

function broadcast(type: string, payload: any) {
  const message = JSON.stringify({ type, payload });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}

engine.setBroadcaster(broadcast);

function maskConfig(cfg: any) {
  const copy = {
    ...cfg,
    proxy: cfg.proxy ? { ...cfg.proxy } : undefined,
    telegram: cfg.telegram ? { ...cfg.telegram } : undefined,
  };
  if (copy.binanceSecretKey) {
    copy.binanceSecretKey = copy.binanceSecretKey.substring(0, 4) + '****************' + copy.binanceSecretKey.slice(-4);
  }
  if (copy.proxy?.password) {
    copy.proxy.password = '******';
  }
  if (copy.telegram?.botToken) {
    const tok = copy.telegram.botToken;
    copy.telegram.botToken = tok.length > 8 ? tok.substring(0, 5) + '****************' + tok.slice(-4) : '******';
  }
  delete copy.adminPassword;
  delete copy.jwtSecret;
  return copy;
}

// Authentication Middleware untuk REST API
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'Akses ditolak: Token autentikasi diperlukan.' });
    return;
  }

  const token = authHeader.split(' ')[1];
  const secret = engine.getConfig().jwtSecret || 'copytrader_secret';
  const payload = AuthService.verifyToken(token, secret);

  if (!payload) {
    res.status(401).json({ success: false, message: 'Sesi kedaluwarsa atau token tidak valid. Silakan login kembali.' });
    return;
  }

  (req as any).user = payload;
  next();
}

// ==========================================
// PUBLIC AUTH ENDPOINTS
// ==========================================
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  const config = engine.getConfig();
  const currentPassword = config.adminPassword || 'admin123';

  if (!password || password !== currentPassword) {
    res.status(401).json({ success: false, message: 'Password salah!' });
    return;
  }

  const secret = config.jwtSecret || 'copytrader_secret';
  const token = AuthService.generateToken({ role: 'admin', loggedInAt: Date.now() }, secret);

  engine.log('SUCCESS', '🔑 Admin berhasil login ke Web Dashboard');
  res.json({ success: true, token, message: 'Login berhasil!' });
});

app.get('/api/auth/check', requireAuth, (req, res) => {
  res.json({ success: true, user: (req as any).user });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const config = engine.getConfig();

  if (!newPassword || newPassword.length < 6) {
    res.status(400).json({ success: false, message: 'Password baru minimal 6 karakter!' });
    return;
  }

  if (currentPassword !== (config.adminPassword || 'admin123')) {
    res.status(400).json({ success: false, message: 'Password lama salah!' });
    return;
  }

  engine.saveConfig({ adminPassword: newPassword });
  engine.log('INFO', '🔒 Password admin berhasil diperbarui.');
  res.json({ success: true, message: 'Password admin berhasil diubah!' });
});

// ==========================================
// PROTECTED REST ENDPOINTS (Wajib Login)
// ==========================================
app.get('/api/config', requireAuth, (req, res) => {
  res.json(maskConfig(engine.getConfig()));
});

app.post('/api/config', requireAuth, (req, res) => {
  try {
    const incoming = req.body;
    const current = engine.getConfig();

    // Jangan timpa jika user tidak mengubah secret key yang ter-mask
    if (incoming.binanceSecretKey && incoming.binanceSecretKey.includes('****')) {
      delete incoming.binanceSecretKey;
    }
    if (incoming.proxy?.password && incoming.proxy.password.includes('****')) {
      incoming.proxy.password = current.proxy?.password;
    }
    if (incoming.telegram?.botToken && incoming.telegram.botToken.includes('****')) {
      incoming.telegram.botToken = current.telegram?.botToken;
    }

    delete incoming.adminPassword; // Gunakan /api/auth/change-password untuk ubah password
    delete incoming.jwtSecret;

    const updated = engine.saveConfig(incoming);
    res.json({ success: true, config: maskConfig(updated) });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const status = engine.getStatus();
    const config = engine.getConfig();
    let userBalance: BalanceInfo | null = null;
    let userPositions: UserPosition[] = [];

    if (config.paperTrading) {
      userBalance = {
        totalWalletBalance: engine.virtualWalletBalance,
        totalUnrealizedProfit: 0,
        totalMarginBalance: engine.virtualWalletBalance,
        availableBalance: engine.virtualWalletBalance,
      };
      userPositions = Array.from(engine.virtualPositions.values());
    } else if (binanceClient.isConfigured()) {
      try {
        userBalance = await binanceClient.getAccountBalance();
        userPositions = await binanceClient.getOpenPositions();
        if (userBalance && (userBalance.totalWalletBalance > 0 || userBalance.availableBalance > 0)) {
          engine.setLastUserAccount(userBalance, userPositions);
        }
      } catch (e: any) {
        const cached = engine.getLastUserAccount();
        userBalance = cached.balance;
        userPositions = cached.positions;
      }
      if (!userBalance) {
        const cached = engine.getLastUserAccount();
        userBalance = cached.balance;
        userPositions = cached.positions;
      }
    }

    res.json({
      status,
      leader: engine.getLastLeaderDetail(),
      user: { balance: userBalance, positions: userPositions },
      logs: engine.getLogs(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/engine/start', requireAuth, (req, res) => {
  try {
    engine.start();
    res.json({ success: true, message: 'Copy Trade Engine started' });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/engine/stop', requireAuth, (req, res) => {
  try {
    engine.stop();
    res.json({ success: true, message: 'Copy Trade Engine stopped' });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/test-proxy', requireAuth, async (req, res) => {
  try {
    const current = engine.getConfig();
    const proxy = req.body.proxy ? { ...req.body.proxy } : (current.proxy ? { ...current.proxy } : undefined);
    if (proxy && proxy.password && proxy.password.includes('****')) {
      proxy.password = current.proxy?.password || '';
    }
    const result = await scraper.testProxy(proxy, current.portfolioId);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/test-telegram', requireAuth, async (req, res) => {
  try {
    const current = engine.getConfig();
    let botToken = req.body.botToken?.trim();
    const chatId = req.body.chatId?.trim();

    if (botToken && botToken.includes('****')) {
      botToken = current.telegram?.botToken || '';
    }

    if (!botToken || !chatId) {
      res.status(400).json({ success: false, message: 'Bot Token dan Chat ID wajib diisi!' });
      return;
    }

    const result = await telegramService.testConnection(botToken, chatId);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/fetch-leader', requireAuth, async (req, res) => {
  try {
    const current = engine.getConfig();
    const portfolioId = req.body.portfolioId || current.portfolioId;
    const proxy = req.body.proxy ? { ...req.body.proxy } : (current.proxy ? { ...current.proxy } : undefined);
    if (proxy && proxy.password && proxy.password.includes('****')) {
      proxy.password = current.proxy?.password || '';
    }
    const result = await scraper.fetchPortfolioDetail(portfolioId, proxy);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ success: false, errorMessage: e.message });
  }
});

app.post('/api/panic-close', requireAuth, async (req, res) => {
  try {
    const message = await engine.panicCloseAll();
    res.json({ success: true, message });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/engine/test-order', requireAuth, async (req, res) => {
  try {
    const { symbol, positionSide, amountUsdt, bypassWeekend } = req.body;
    const result = await engine.executeTestTrade({
      symbol,
      positionSide,
      amountUsdt: amountUsdt ? parseFloat(amountUsdt) : undefined,
      bypassWeekend: Boolean(bypassWeekend),
    });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/positions/sync-avg-down', requireAuth, async (req, res) => {
  try {
    const { symbol, positionSide } = req.body;
    if (!symbol || !positionSide) {
      res.status(400).json({ success: false, message: 'Symbol dan positionSide wajib diisi!' });
      return;
    }
    const result = await engine.syncAveragingDown(symbol, positionSide);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/schedule', requireAuth, (req, res) => {
  res.json({
    success: true,
    schedule: engine.getConfig().dailySchedule || {
      enabled: false,
      startTime: '10:00',
      endTime: '18:30',
      action: 'FULL_STOP',
      guardOpenPositions: true,
    },
    status: engine.getDailyScheduleStatus(),
  });
});

app.post('/api/schedule', requireAuth, (req, res) => {
  try {
    const { enabled, startTime, endTime, action, guardOpenPositions, autoAbortOnLeaderTrade } = req.body;
    const currentCfg = engine.getConfig().dailySchedule || {
      enabled: false,
      startTime: '10:00',
      endTime: '18:30',
      action: 'FULL_STOP',
      guardOpenPositions: true,
      autoAbortOnLeaderTrade: true,
    };
    const newSchedule = {
      enabled: typeof enabled === 'boolean' ? enabled : currentCfg.enabled,
      startTime: startTime ? String(startTime).trim() : currentCfg.startTime,
      endTime: endTime ? String(endTime).trim() : currentCfg.endTime,
      action: (action === 'STANDBY' ? 'STANDBY' : 'FULL_STOP') as 'STANDBY' | 'FULL_STOP',
      guardOpenPositions: guardOpenPositions !== false,
      autoAbortOnLeaderTrade: typeof autoAbortOnLeaderTrade === 'boolean' ? autoAbortOnLeaderTrade : (currentCfg.autoAbortOnLeaderTrade !== false),
    };

    engine.saveConfig({ dailySchedule: newSchedule });
    res.json({
      success: true,
      message: 'Jadwal istirahat harian berhasil disimpan.',
      schedule: newSchedule,
      status: engine.getDailyScheduleStatus(),
    });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/schedule/reset-abort', requireAuth, (req, res) => {
  try {
    engine.resetDailyScheduleAbort();
    res.json({
      success: true,
      message: 'Status pembatalan jadwal istirahat berhasil di-reset.',
      status: engine.getStatus(),
    });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/weekend-break/reset-abort', requireAuth, (req, res) => {
  try {
    engine.resetWeekendHoliday();
    res.json({
      success: true,
      message: 'Status pembatalan libur akhir pekan berhasil di-reset.',
      status: engine.getStatus(),
    });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/clear-logs', requireAuth, (req, res) => {
  engine.clearLogs();
  res.json({ success: true, message: 'Log terminal telah dibersihkan.' });
});

app.post('/api/reset-demo', requireAuth, (req, res) => {
  engine.resetDemo();
  res.json({ success: true, message: 'Riwayat dan posisi demo berhasil di-reset.' });
});

app.get('/api/closed-trades', requireAuth, (req, res) => {
  res.json({ success: true, trades: engine.getClosedTrades() });
});

app.get('/api/daily-snapshots', requireAuth, async (req, res) => {
  try {
    const days = req.query.days ? parseInt(req.query.days as string, 10) : 60;
    const snapshots = await engine.getDailySnapshots(days);
    res.json({ success: true, data: snapshots });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/daily-snapshots/take', requireAuth, async (req, res) => {
  try {
    const snapshot = await engine.takeDailyBalanceSnapshot(undefined, false);
    res.json({
      success: true,
      message: `Snapshot saldo harian (${snapshot.date}) berhasil disimpan!`,
      data: snapshot,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/clear-closed-trades', requireAuth, (req, res) => {
  engine.clearClosedTrades();
  res.json({ success: true, message: 'Riwayat trade selesai telah dibersihkan.' });
});

// Fallback index.html
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, async () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Binance Copy Trader berjalan di: http://localhost:${PORT}`);
  console.log(`🔒 Sistem Autentikasi Admin: AKTIF`);
  console.log(`🔑 Password Default: admin123 (Dapat diubah di Settings)`);
  console.log(`======================================================\n`);

  // Inisialisasi Database (PostgreSQL) dan sinkronisasi state
  await engine.init();

  // Ambil snapshot data leader pertama kali saat server start
  setTimeout(() => {
    engine.fetchLeaderSnapshot().catch(() => {});
  }, 1000);

  // AUTO-RESUME: Jika sebelum restart status trading AKTIF (copyTradeActive: true), otomatis langsung ON!
  const cfg = engine.getConfig();
  if (cfg.copyTradeActive) {
    console.log(`[Auto-Start] 🟢 Parameter copyTradeActive bernilai ON (Aktif). Menyalakan engine otomatis...`);
    engine.start(true);
  } else {
    console.log(`[Auto-Start] ⏸️ Parameter copyTradeActive bernilai OFF (Standby). Menunggu tombol Start dari Dashboard.`);
  }
});
