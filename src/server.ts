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
    initUserPositions = Array.from(engine.virtualPositions.values());
  } else {
    initUserBalance = {
      totalWalletBalance: 0,
      totalUnrealizedProfit: 0,
      totalMarginBalance: 0,
      availableBalance: 0,
    };
  }

  // Kirim data awal saat connect
  ws.send(JSON.stringify({
    type: 'INIT',
    payload: {
      status: engine.getStatus(),
      config: maskConfig(cfg),
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
  };
  if (copy.binanceSecretKey) {
    copy.binanceSecretKey = copy.binanceSecretKey.substring(0, 4) + '****************' + copy.binanceSecretKey.slice(-4);
  }
  if (copy.proxy?.password) {
    copy.proxy.password = '******';
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
      } catch (e: any) {
        // Handle silently
      }
    }

    res.json({
      status,
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
    const result = await scraper.testProxy(proxy);
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

app.post('/api/clear-closed-trades', requireAuth, (req, res) => {
  engine.clearClosedTrades();
  res.json({ success: true, message: 'Riwayat trade selesai telah dibersihkan.' });
});

// Fallback index.html
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Binance Copy Trader berjalan di: http://localhost:${PORT}`);
  console.log(`🔒 Sistem Autentikasi Admin: AKTIF`);
  console.log(`🔑 Password Default: admin123 (Dapat diubah di Settings)`);
  console.log(`======================================================\n`);
});
