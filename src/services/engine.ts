import fs from 'fs';
import path from 'path';
import { AppConfig, EngineStatus, LeadPosition, LogEntry, UserPosition, BalanceInfo, ClosedTrade, PollingStatusInfo, LeadPortfolioDetail, WeekendBreakStatus } from '../types';
import { binanceClient } from './binance';
import { scraper } from './scraper';
import { telegramService } from './telegram';
import { dbService } from './db';

const CONFIG_PATH = path.resolve(__dirname, '../../config.json');
const VIRTUAL_STATE_PATH = path.resolve(__dirname, '../../virtual_state.json');
const TRADE_HISTORY_PATH = path.resolve(__dirname, '../../trade_history.json');

export class CopyTradeEngine {
  private config: AppConfig;
  private isRunning: boolean = false;
  private isFirstTick: boolean = true;
  private pollTimeout: NodeJS.Timeout | null = null;
  private lastLeaderPositions: Map<string, LeadPosition> = new Map();
  private lastLeaderEquity: number = 0;
  private lastLeaderDetail: LeadPortfolioDetail | null = null;
  private logs: LogEntry[] = [];
  private pollCount: number = 0;
  private lastError: string | null = null;
  private consecutiveProxyErrors: number = 0;
  private lastProcessedOrderTime: number = 0;
  private lastSessionKey: string = '';
  private lastUserPositionsCount: number = 0;
  private isHolidayActive: boolean = false;
  public virtualPositions: Map<string, UserPosition> = new Map();
  public streamLeaderPositions: Map<string, LeadPosition> = new Map();
  public positionAvgCounts: Map<string, { leader: number; user: number }> = new Map();
  public virtualWalletBalance: number = 100;
  public recentlyClosedCoins: Map<string, { symbol: string; positionSide: 'LONG' | 'SHORT'; closedAt: number; action: string }> = new Map();
  private closedTrades: ClosedTrade[] = [];
  private wsBroadcaster: ((type: string, payload: any) => void) | null = null;

  constructor() {
    this.config = this.loadConfig();
    this.virtualWalletBalance = this.config.virtualBalanceUsdt ?? 100;
    this.loadVirtualState();
    this.loadTradeHistory();
    this.initServices();
  }

  /**
   * Inisialisasi Database (PostgreSQL) dan sinkronisasi data terbaru
   */
  async init(): Promise<void> {
    const dbConnected = await dbService.init();
    if (dbConnected) {
      // 1. Muat konfigurasi dari DB jika ada
      const dbConfig = await dbService.loadConfig();
      if (dbConfig) {
        this.config = dbConfig;
        this.virtualWalletBalance = this.config.virtualBalanceUsdt ?? 100;
        this.initServices();
      }

      // 2. Muat virtual state dari DB jika ada
      const dbVs = await dbService.loadVirtualState();
      if (dbVs) {
        if (typeof dbVs.virtualWalletBalance === 'number') {
          this.virtualWalletBalance = dbVs.virtualWalletBalance;
        }
        if (Array.isArray(dbVs.virtualPositions)) {
          this.virtualPositions = new Map(dbVs.virtualPositions);
          for (const [key, pos] of this.virtualPositions) {
            if (pos && typeof pos.margin !== 'number') {
              pos.margin = (Math.abs(pos.positionAmt) * (pos.entryPrice || pos.markPrice || 0)) / Math.max(1, pos.leverage || 10);
            }
          }
        }
        if (Array.isArray(dbVs.streamLeaderPositions)) {
          this.streamLeaderPositions = new Map(dbVs.streamLeaderPositions);
        }
        if (Array.isArray(dbVs.positionAvgCounts)) {
          this.positionAvgCounts = new Map(dbVs.positionAvgCounts);
        }
        if (typeof dbVs.lastProcessedOrderTime === 'number' && dbVs.lastProcessedOrderTime > 0) {
          this.lastProcessedOrderTime = dbVs.lastProcessedOrderTime;
        }
        if (this.virtualPositions.size > 0) {
          this.log('INFO', `💾 Memulihkan ${this.virtualPositions.size} posisi virtual dari PostgreSQL (Saldo: $${this.virtualWalletBalance.toFixed(2)} USDT)`);
        }
        if (this.streamLeaderPositions.size > 0) {
          this.log('INFO', `🔒 Memulihkan ${this.streamLeaderPositions.size} posisi leader stream (mode privat) dari PostgreSQL.`);
        }
      }

      // 3. Muat riwayat trade dari DB jika ada
      const dbTrades = await dbService.loadTradeHistory(250);
      if (dbTrades && dbTrades.length > 0) {
        this.closedTrades = dbTrades;
        this.log('INFO', `📜 Memulihkan ${dbTrades.length} riwayat trade dari PostgreSQL.`);
      }
    }
  }

  private saveVirtualState() {
    try {
      const data = {
        virtualWalletBalance: this.virtualWalletBalance,
        virtualPositions: Array.from(this.virtualPositions.entries()),
        streamLeaderPositions: Array.from(this.streamLeaderPositions.entries()),
        positionAvgCounts: Array.from(this.positionAvgCounts.entries()),
        lastProcessedOrderTime: this.lastProcessedOrderTime,
      };
      fs.writeFileSync(VIRTUAL_STATE_PATH, JSON.stringify(data, null, 2), 'utf-8');
      dbService.saveVirtualState(data).catch(() => {});
    } catch {}
  }

  private loadVirtualState() {
    try {
      if (fs.existsSync(VIRTUAL_STATE_PATH)) {
        const raw = fs.readFileSync(VIRTUAL_STATE_PATH, 'utf-8');
        const data = JSON.parse(raw);
        if (typeof data.virtualWalletBalance === 'number') {
          this.virtualWalletBalance = data.virtualWalletBalance;
        }
        if (Array.isArray(data.virtualPositions)) {
          this.virtualPositions = new Map(data.virtualPositions);
          for (const [key, pos] of this.virtualPositions) {
            if (pos && typeof pos.margin !== 'number') {
              pos.margin = (Math.abs(pos.positionAmt) * (pos.entryPrice || pos.markPrice || 0)) / Math.max(1, pos.leverage || 10);
            }
          }
        }
        if (Array.isArray(data.streamLeaderPositions)) {
          this.streamLeaderPositions = new Map(data.streamLeaderPositions);
        }
        if (Array.isArray(data.positionAvgCounts)) {
          this.positionAvgCounts = new Map(data.positionAvgCounts);
        }
        if (typeof data.lastProcessedOrderTime === 'number' && data.lastProcessedOrderTime > 0) {
          this.lastProcessedOrderTime = data.lastProcessedOrderTime;
        }
        if (this.virtualPositions.size > 0) {
          this.log('INFO', `💾 Memulihkan ${this.virtualPositions.size} posisi virtual tersimpan dari disk (Saldo: $${this.virtualWalletBalance.toFixed(2)} USDT)`);
        }
        if (this.streamLeaderPositions.size > 0) {
          this.log('INFO', `🔒 Memulihkan ${this.streamLeaderPositions.size} posisi leader stream (mode privat) dari disk.`);
        }
      }
    } catch {}
  }

  private saveTradeHistory() {
    try {
      fs.writeFileSync(TRADE_HISTORY_PATH, JSON.stringify(this.closedTrades, null, 2), 'utf-8');
    } catch {}
  }

  private loadTradeHistory() {
    try {
      if (fs.existsSync(TRADE_HISTORY_PATH)) {
        const raw = fs.readFileSync(TRADE_HISTORY_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.closedTrades = parsed;
        }
      }
    } catch {}
  }

  getClosedTrades(): ClosedTrade[] {
    return this.closedTrades;
  }

  clearClosedTrades() {
    this.closedTrades = [];
    this.saveTradeHistory();
    dbService.clearTradeHistory().catch(() => {});
    this.log('INFO', '🧹 Riwayat trade selesai telah dibersihkan.');
  }

  recordClosedTrade(trade: Omit<ClosedTrade, 'id' | 'timestamp' | 'closedAt'>) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateStr = now.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
    const fullTrade: ClosedTrade = {
      ...trade,
      id: Math.random().toString(36).substring(2, 9) + Date.now().toString(36),
      timestamp: now.getTime(),
      closedAt: `${dateStr} ${timeStr}`,
    };

    this.closedTrades.unshift(fullTrade);
    if (this.closedTrades.length > 250) {
      this.closedTrades = this.closedTrades.slice(0, 250);
    }
    this.saveTradeHistory();
    dbService.insertClosedTrade(fullTrade).catch(() => {});

    // Catat koin yang baru ditutup untuk keperluan Smart Re-Entry di akhir pekan
    if (fullTrade.action === 'FULL_CLOSE' || fullTrade.action === 'EMERGENCY_SL' || fullTrade.action === 'PANIC_CLOSE') {
      this.recentlyClosedCoins.set(fullTrade.symbol, {
        symbol: fullTrade.symbol,
        positionSide: fullTrade.positionSide,
        closedAt: now.getTime(),
        action: fullTrade.action,
      });
    }

    if (this.wsBroadcaster) {
      this.wsBroadcaster('CLOSED_TRADE', fullTrade);
    }

    // Kirim notifikasi Telegram saat posisi ditutup
    const isWin = fullTrade.realizedPnl >= 0;
    const emoji = isWin ? '🎯 [PROFIT]' : '🔻 [LOSS]';
    const actionLabel = fullTrade.action === 'FULL_CLOSE'
      ? 'Tutup Penuh'
      : fullTrade.action === 'PARTIAL_CLOSE'
      ? 'Tutup Parsial'
      : fullTrade.action === 'EMERGENCY_SL'
      ? 'Emergency Stop Loss'
      : fullTrade.action === 'PANIC_CLOSE'
      ? 'Panic Close All'
      : fullTrade.action;

    this.sendTelegram(
      `${isWin ? '🟢' : '🔴'} <b>TRADE DITUTUP: ${emoji}</b>\n\n` +
      `🪙 Simbol: <b>${fullTrade.symbol}</b> (${fullTrade.positionSide})\n` +
      `⚡ Aksi: <b>${actionLabel}</b>\n` +
      `💵 Entry: <b>$${fullTrade.entryPrice}</b> ➜ Exit: <b>$${fullTrade.closePrice}</b>\n` +
      `💰 Realized PnL: <b>${fullTrade.realizedPnl >= 0 ? '+' : ''}$${fullTrade.realizedPnl} USDT (${fullTrade.pnlPct >= 0 ? '+' : ''}${fullTrade.pnlPct}%)</b>\n` +
      `📦 Volume: <b>${fullTrade.qty}</b>\n` +
      `🏷️ Mode: ${fullTrade.isPaper ? '🧪 Simulasi Demo' : '🟢 Live Futures'}`
    );
  }

  setBroadcaster(fn: (type: string, payload: any) => void) {
    this.wsBroadcaster = fn;
  }

  private loadConfig(): AppConfig {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed.adminPassword) parsed.adminPassword = 'admin123';
        if (!parsed.jwtSecret) parsed.jwtSecret = Math.random().toString(36).substring(2) + Date.now().toString(36);
        if (parsed.paperTrading === undefined) parsed.paperTrading = true;
        if (parsed.virtualBalanceUsdt === undefined) parsed.virtualBalanceUsdt = 100;
        if (!parsed.weekendBreak) {
          parsed.weekendBreak = {
            enabled: true,
            timezone: 'CST',
            standbyIntervalSec: 60,
            blockNewTrades: true,
            smartReEntryEnabled: true,
            reEntryWindowMinutes: 30,
          };
        } else {
          if (parsed.weekendBreak.smartReEntryEnabled === undefined) parsed.weekendBreak.smartReEntryEnabled = true;
          if (parsed.weekendBreak.reEntryWindowMinutes === undefined) parsed.weekendBreak.reEntryWindowMinutes = 30;
        }
        return parsed;
      }
    } catch (e: any) {
      this.log('WARN', `Gagal memuat config.json, menggunakan default: ${e.message}`);
    }

    return {
      portfolioId: '5154344801714752768',
      copyTradeActive: false,
      paperTrading: true,
      virtualBalanceUsdt: 100.0,
      binanceApiKey: '',
      binanceSecretKey: '',
      isTestnet: false,
      mode: 'RATIO_EQUITY',
      ratioMultiplier: 1.0,
      fixedAmountUsdt: 25.0,
      maxModalPerCoin: 0,
      maxSlippagePct: 0.5,
      syncLeverage: true,
      emergencySlPct: 10.0,
      pollingIntervalMs: 2500,
      weekendBreak: {
        enabled: true,
        timezone: 'CST',
        standbyIntervalSec: 60,
        blockNewTrades: true,
        smartReEntryEnabled: true,
        reEntryWindowMinutes: 30,
      },
      proxy: {
        enabled: false,
        host: '',
        port: 823,
        username: '',
        password: '',
      },
      adminPassword: 'admin123',
      jwtSecret: Math.random().toString(36).substring(2) + Date.now().toString(36),
    };
  }

  saveConfig(newConfig: Partial<AppConfig>): AppConfig {
    const portfolioChanged = newConfig.portfolioId && newConfig.portfolioId !== this.config.portfolioId;

    this.config = { ...this.config, ...newConfig };

    // Jika target leader diganti, bersihkan tracking posisi lama agar tidak memicu deteksi posisi palsu
    if (portfolioChanged) {
      this.lastLeaderPositions.clear();
      this.lastLeaderEquity = 0;
      this.lastProcessedOrderTime = 0;
      this.isFirstTick = true;
      this.log('INFO', `🔄 Target Leader diperbarui ke ID: ${this.config.portfolioId}. Tracking posisi di-reset.`);
    }

    // Jika virtual balance diubah di pengaturan, sesuaikan saldo virtual dan simpan ke disk
    if (newConfig.virtualBalanceUsdt !== undefined && !isNaN(Number(newConfig.virtualBalanceUsdt))) {
      const newBal = Number(newConfig.virtualBalanceUsdt);
      if (newBal > 0) {
        this.virtualWalletBalance = newBal;
        this.saveVirtualState();
      }
    }

    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
      dbService.saveConfig(this.config).catch(() => {});
      this.initServices();
      this.log('INFO', 'Pengaturan berhasil disimpan');
    } catch (e: any) {
      this.log('ERROR', `Gagal menyimpan konfigurasi: ${e.message}`);
    }
    return this.config;
  }

  getConfig(): AppConfig {
    return this.config;
  }

  private initServices() {
    binanceClient.configure(this.config.binanceApiKey, this.config.binanceSecretKey, this.config.isTestnet);
    telegramService.configure(this.config.telegram);
  }

  private lastTelegramAlertTime: { [key: string]: number } = {};

  sendTelegram(text: string) {
    telegramService.sendMessage(text).catch(() => {});
  }

  sendTelegramRateLimited(key: string, text: string, cooldownMs: number = 600000) {
    const now = Date.now();
    if (!this.lastTelegramAlertTime[key] || now - this.lastTelegramAlertTime[key] > cooldownMs) {
      this.lastTelegramAlertTime[key] = now;
      this.sendTelegram(text);
    }
  }

  log(level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS', message: string) {
    const entry: LogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString('id-ID', { hour12: false }),
      level,
      message,
    };
    this.logs.unshift(entry);
    if (this.logs.length > 150) this.logs.pop();

    console.log(`[${entry.timestamp}] [${level}] ${message}`);

    if (this.wsBroadcaster) {
      this.wsBroadcaster('LOG', entry);
    }
  }

  getLogs(): LogEntry[] {
    return this.logs;
  }

  clearLogs() {
    this.logs = [];
  }

  resetDemo() {
    this.virtualPositions.clear();
    this.streamLeaderPositions.clear();
    this.positionAvgCounts.clear();
    this.virtualWalletBalance = this.config.virtualBalanceUsdt ?? 100;
    this.logs = [];
    this.lastProcessedOrderTime = 0;
    try {
      if (fs.existsSync(VIRTUAL_STATE_PATH)) {
        fs.unlinkSync(VIRTUAL_STATE_PATH);
      }
    } catch {}
    dbService.resetVirtualState(this.virtualWalletBalance).catch(() => {});
    this.log('INFO', '🧹 Riwayat demo & posisi virtual telah di-reset bersih.');
  }

  getVirtualPositions(): UserPosition[] {
    const list = Array.from(this.virtualPositions.values());
    for (const p of list) {
      const counts = this.positionAvgCounts.get(`${p.symbol}_${p.positionSide}`);
      p.avgCount = counts?.user || 0;
    }
    return list;
  }

  getLastLeaderDetail(): LeadPortfolioDetail | null {
    if (this.lastLeaderDetail) {
      const positions = (this.lastLeaderDetail.positionShow === false
        ? Array.from(this.streamLeaderPositions.values())
        : this.lastLeaderDetail.positions) || [];
      for (const p of positions) {
        const counts = this.positionAvgCounts.get(`${p.symbol}_${p.positionSide}`);
        p.avgCount = counts?.leader || 0;
      }
      return {
        ...this.lastLeaderDetail,
        positions,
      };
    }
    return null;
  }

  async fetchLeaderSnapshot(): Promise<LeadPortfolioDetail | null> {
    if (!this.config.portfolioId) return null;
    try {
      const detail = await scraper.fetchPortfolioDetail(this.config.portfolioId, this.config.proxy);
      if (detail.isSuccess) {
        if (detail.positionShow === false) {
          detail.positions = Array.from(this.streamLeaderPositions.values());
        }
        if (detail.positions && detail.positions.length > 0) {
          for (const lp of detail.positions) {
            const counts = this.positionAvgCounts.get(`${lp.symbol}_${lp.positionSide}`);
            lp.avgCount = counts?.leader || 0;
            if (!lp.markPrice || lp.markPrice <= 0) {
              try {
                const mp = await binanceClient.getSymbolPrice(lp.symbol);
                if (mp > 0) lp.markPrice = mp;
              } catch {}
            }
          }
        }
        if (this.wsBroadcaster) {
          this.wsBroadcaster('TICK', {
            status: this.getStatus(),
            leader: {
              nickname: detail.nickname,
              avatarUrl: detail.avatarUrl,
              totalEquity: detail.totalEquity,
              roi7d: detail.roi7d,
              mdd7d: detail.mdd7d,
              winRate: detail.winRate,
              followerCount: detail.followerCount,
              maxFollowerCount: detail.maxFollowerCount,
              positionShow: detail.positionShow,
              positions: detail.positions || [],
              orders: detail.orders || [],
            },
          });
        }
        return detail;
      }
    } catch {}
    return null;
  }

  /**
   * Mengembalikan waktu China (CST, UTC+8) dan waktu WIB (UTC+7)
   */
  getTimes() {
    const now = new Date();
    // UTC time
    const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
    const cstTime = new Date(utcMs + (8 * 3600000));
    const wibTime = new Date(utcMs + (7 * 3600000));

    const daysId = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

    const cstDay = cstTime.getDay(); // 0 = Minggu, 6 = Sabtu
    const isWeekendCST = (cstDay === 0 || cstDay === 6);

    const cstHh = String(cstTime.getHours()).padStart(2, '0');
    const cstMm = String(cstTime.getMinutes()).padStart(2, '0');
    const cstTimeStr = `${daysId[cstDay]}, ${cstHh}:${cstMm} CST`;

    const wibDay = wibTime.getDay();
    const wibHh = String(wibTime.getHours()).padStart(2, '0');
    const wibMm = String(wibTime.getMinutes()).padStart(2, '0');
    const wibTimeStr = `${daysId[wibDay]}, ${wibHh}:${wibMm} WIB`;

    return {
      cstTime,
      wibTime,
      cstDay,
      isWeekendCST,
      cstTimeStr,
      wibTimeStr,
      wibHour: wibTime.getHours(),
      wibMinute: wibTime.getMinutes(),
    };
  }

  getUserPositionsCount(): number {
    if (this.config.paperTrading) {
      return this.virtualPositions.size;
    }
    return this.lastUserPositionsCount;
  }

  getWeekendBreakStatus(overridePositionsCount?: number): WeekendBreakStatus {
    const times = this.getTimes();
    const isWeekend = times.isWeekendCST;
    const cfg = this.config.weekendBreak;

    const count = overridePositionsCount !== undefined ? overridePositionsCount : this.getUserPositionsCount();
    const hasOpenPositions = count > 0;

    // Evaluasi Smart Re-Entry Grace Window
    const reEntryWindowMs = (cfg?.reEntryWindowMinutes || 30) * 60 * 1000;
    let inReEntryWindow = false;
    let reEntryRemainingMins = 0;

    if (cfg?.smartReEntryEnabled !== false && !hasOpenPositions) {
      const now = Date.now();
      for (const [sym, item] of this.recentlyClosedCoins.entries()) {
        const elapsed = now - item.closedAt;
        if (elapsed <= reEntryWindowMs) {
          inReEntryWindow = true;
          const remaining = Math.ceil((reEntryWindowMs - elapsed) / 60000);
          if (remaining > reEntryRemainingMins) {
            reEntryRemainingMins = remaining;
          }
        } else {
          this.recentlyClosedCoins.delete(sym);
        }
      }
    }

    const isHolidayActive = Boolean(cfg?.enabled && isWeekend && !hasOpenPositions && !inReEntryWindow);

    return {
      isWeekendCST: isWeekend,
      hasOpenPositions,
      isHolidayActive,
      inReEntryWindow,
      reEntryRemainingMins,
      cstTimeStr: times.cstTimeStr,
      wibTimeStr: times.wibTimeStr,
      resumeTimeStr: 'Senin 00:00 CST (Minggu 23:00 WIB)',
    };
  }

  getCurrentPollingInfo(): PollingStatusInfo {
    const times = this.getTimes();
    const weekendStatus = this.getWeekendBreakStatus();

    // 1. Jika dalam Jendela Toleransi Smart Re-Entry (tetap polling aktif agar re-entry cepat tertangkap)
    if (weekendStatus.inReEntryWindow) {
      return {
        isAdaptive: false,
        currentIntervalMs: 2000,
        sessionName: `🎯 Toleransi Re-Entry (${weekendStatus.reEntryRemainingMins}m sisa)`,
        sessionKey: 'weekend_break',
        wibTimeStr: times.wibTimeStr,
        cstTimeStr: times.cstTimeStr,
        isWeekendHoliday: false,
      };
    }

    // 2. Jika Mode Libur Akhir Pekan aktif (akhir pekan CST & tidak ada posisi terbuka & luar re-entry window)
    if (weekendStatus.isHolidayActive) {
      const standbySec = this.config.weekendBreak?.standbyIntervalSec || 60;
      return {
        isAdaptive: false,
        currentIntervalMs: standbySec * 1000,
        sessionName: '🌴 Libur Akhir Pekan (Standby CST)',
        sessionKey: 'weekend_break',
        wibTimeStr: times.wibTimeStr,
        cstTimeStr: times.cstTimeStr,
        isWeekendHoliday: true,
      };
    }

    // 2. Jika Polling Adaptif tidak aktif
    if (!this.config.adaptivePolling?.enabled) {
      return {
        isAdaptive: false,
        currentIntervalMs: this.config.pollingIntervalMs || 1500,
        sessionName: 'Manual (Tetap)',
        sessionKey: 'manual',
        wibTimeStr: times.wibTimeStr,
        cstTimeStr: times.cstTimeStr,
        isWeekendHoliday: false,
      };
    }

    // 3. Polling Adaptif Sesi Jam Pasar (WIB)
    const cfg = this.config.adaptivePolling;
    const hour = times.wibHour;
    let intervalMs = 1500;
    let sessionName = '';
    let sessionKey: 'dawn' | 'morning' | 'afternoon' | 'night' = 'dawn';

    if (hour >= 0 && hour < 7) {
      // 00:00 - 06:59 WIB (Sesi New York / Paling Agresif)
      intervalMs = cfg.dawnIntervalMs || 1000;
      sessionName = 'Dini Hari (New York Active - Agresif)';
      sessionKey = 'dawn';
    } else if (hour >= 7 && hour < 12) {
      // 07:00 - 11:59 WIB (Sesi Asia Tokyo/Singapura - Sedang)
      intervalMs = cfg.morningIntervalMs || 1800;
      sessionName = 'Pagi (Sesi Asia - Sedang)';
      sessionKey = 'morning';
    } else if (hour >= 12 && hour < 19) {
      // 12:00 - 18:59 WIB (Sesi Siang Asia / London Awal - Sepi)
      intervalMs = cfg.afternoonIntervalMs || 3000;
      sessionName = 'Siang/Sore (Sesi Sepi - Hemat Kuota)';
      sessionKey = 'afternoon';
    } else {
      // 19:00 - 23:59 WIB (Sesi London Sore / Awal New York - Pemanasan)
      intervalMs = cfg.nightIntervalMs || 1500;
      sessionName = 'Malam (Pemanasan New York)';
      sessionKey = 'night';
    }

    // Jika akhir pekan tapi masih ada posisi terbuka, berikan catatan status
    if (weekendStatus.isWeekendCST && weekendStatus.hasOpenPositions) {
      sessionName += ' (Mengawal Posisi Terbuka)';
    }

    // Log transisi jika berpindah sesi
    if (this.lastSessionKey && this.lastSessionKey !== sessionKey) {
      this.log('INFO', `⏰ [JADWAL ADAPTIF] Berganti ke Sesi ${sessionName} (${times.wibTimeStr}) - Kecepatan Polling: ${(intervalMs / 1000).toFixed(1)} detik`);
    }
    this.lastSessionKey = sessionKey;

    return {
      isAdaptive: true,
      currentIntervalMs: intervalMs,
      sessionName,
      sessionKey,
      wibTimeStr: times.wibTimeStr,
      cstTimeStr: times.cstTimeStr,
      isWeekendHoliday: false,
    };
  }

  getStatus(): EngineStatus {
    const userPositions = this.config.paperTrading
      ? Array.from(this.virtualPositions.values())
      : [];
    const count = this.config.paperTrading ? this.virtualPositions.size : this.lastUserPositionsCount;
    const weekendBreakStatus = this.getWeekendBreakStatus(count);

    return {
      isActive: this.isRunning,
      portfolioId: this.config.portfolioId,
      lastPollTime: this.pollCount > 0 ? new Date().toLocaleTimeString('id-ID') : null,
      pollCount: this.pollCount,
      leaderEquity: this.lastLeaderEquity,
      userEquity: this.config.paperTrading ? this.virtualWalletBalance : 0,
      leaderPositionsCount: this.lastLeaderPositions.size,
      userPositionsCount: userPositions.length,
      activePairs: Array.from(this.lastLeaderPositions.keys()),
      lastError: this.lastError,
      pollingInfo: this.getCurrentPollingInfo(),
      weekendBreak: weekendBreakStatus,
    };
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isFirstTick = true;
    this.lastProcessedOrderTime = 0;
    this.config.copyTradeActive = true;
    this.saveConfig({ copyTradeActive: true });
    const modeTag = this.config.paperTrading ? '🧪 [MODE SIMULASI / PAPER TRADE]' : '🟢 [LIVE TRADING]';
    const pollInfo = this.getCurrentPollingInfo();
    const pollDesc = pollInfo.isAdaptive
      ? `⚡ Polling Adaptif Cerdas WIB: Sesi ${pollInfo.sessionName} @ ${(pollInfo.currentIntervalMs / 1000).toFixed(1)}s (${pollInfo.wibTimeStr})`
      : `⏱️ Polling Manual Tetap: ${(pollInfo.currentIntervalMs / 1000).toFixed(1)}s`;
    this.log('SUCCESS', `🚀 Copy Trade Engine DIAKTIFKAN (${modeTag}) | ${pollDesc} untuk Leader: ${this.config.portfolioId}`);
    this.runLoop();
  }

  stop() {
    this.isRunning = false;
    this.config.copyTradeActive = false;
    this.saveConfig({ copyTradeActive: false });
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    this.log('WARN', '🛑 Copy Trade Engine DINONAKTIFKAN.');
  }

  private async runLoop() {
    if (!this.isRunning) return;

    try {
      await this.executeTick();
      this.lastError = null;
    } catch (err: any) {
      this.lastError = err.message;
      this.log('ERROR', `Error pada loop copy-trade: ${err.message}`);
    }

    // Interval acak (jitter ~15%) untuk menghindari ritme kaku dan deteksi bot
    const pollInfo = this.getCurrentPollingInfo();
    const baseInterval = pollInfo.currentIntervalMs;
    const jitter = pollInfo.isWeekendHoliday
      ? 0
      : Math.floor(Math.random() * (baseInterval * 0.2)) - Math.floor(baseInterval * 0.1);
    const interval = Math.max(800, Math.round(baseInterval + jitter));

    if (this.isRunning) {
      this.pollTimeout = setTimeout(() => this.runLoop(), interval);
    }
  }

  private async executeTick() {
    this.pollCount++;

    // 1. Fetch data posisi leader
    const leaderDetail = await scraper.fetchPortfolioDetail(this.config.portfolioId, this.config.proxy);
    if (!leaderDetail.isSuccess) {
      const isIpBlocked = leaderDetail.errorMessage?.includes('403');
      const isQuotaOut = leaderDetail.errorMessage?.includes('407');

      if (isIpBlocked) {
        this.lastError = leaderDetail.errorMessage || 'IP_BLOCKED_403';
        this.log('ERROR', `🚨 [CRITICAL ALERT] IP PROXY DIBLOKIR BINANCE/CLOUDFLARE (HTTP 403)! Posisi akun Anda DIKUNCI AMAN (tidak akan ditutup). Harap segera ganti IP proxy di menu Pengaturan.`);
        this.sendTelegramRateLimited('IP_BLOCKED', `🚨 <b>[CRITICAL ALERT] IP PROXY DIBLOKIR (HTTP 403)</b>\n\nBinance/Cloudflare memblokir IP proxy Anda. Posisi akun Anda telah DIKUNCI AMAN (tidak akan ditutup sembarangan). Harap segera perbarui IP proxy di dashboard.`);
      } else if (isQuotaOut) {
        this.lastError = leaderDetail.errorMessage || 'PROXY_AUTH_407';
        this.log('ERROR', `🚨 [CRITICAL ALERT] KUOTA PROXY HABIS / AUTENTIKASI GAGAL (HTTP 407)! Harap isi ulang kuota proxy Anda.`);
        this.sendTelegramRateLimited('QUOTA_OUT', `🚨 <b>[CRITICAL ALERT] KUOTA PROXY HABIS (HTTP 407)</b>\n\nKuota proxy DataImpulse Anda telah habis. Harap isi ulang kuota/bandwith proxy agar copy trade dapat berlanjut.`);
      } else {
        // Kedipan jaringan / transient proxy error (timeout, SSL glitch, socket idle)
        this.consecutiveProxyErrors++;

        // HANYA tampilkan peringatan di log jika kegagalan terjadi beruntun >= 3 kali
        // (mencegah kedipan sesaat 1-2 tick mengotori terminal atau membuat cemas pengguna)
        if (this.consecutiveProxyErrors >= 3) {
          this.lastError = leaderDetail.errorMessage || 'Koneksi proxy tidak stabil';
          // Rate-limited: Tampilkan di log pada kali ke-3, lalu setiap kelipatan 10 jika berkepanjangan
          if (this.consecutiveProxyErrors === 3 || this.consecutiveProxyErrors % 10 === 0) {
            this.log('WARN', `⚠️ Koneksi proxy tidak stabil (${this.consecutiveProxyErrors}x berturut-turut): ${leaderDetail.errorMessage}. Melewatkan tick demi keamanan.`);
          }
        }
      }

      // Broadcast update ke UI dashboard agar indikator status error segera terlihat
      if (this.wsBroadcaster) {
        this.wsBroadcaster('TICK', {
          status: this.getStatus(),
        });
      }

      return; // SAFETY LOCK: Menghentikan eksekusi tick! Posisi akun Anda TIDAK AKAN DITUTUP SEMBARANGAN.
    }

    // Reset status error jika koneksi sukses pulih
    if (this.lastError) {
      this.log('SUCCESS', `✅ Koneksi ke Binance Copy Trading berhasil pulih kembali normal.`);
      this.lastError = null;
    }
    this.consecutiveProxyErrors = 0;

    this.lastLeaderEquity = leaderDetail.totalEquity || this.lastLeaderEquity;
    let currentLeaderPositions = leaderDetail.positions || [];
    for (const p of currentLeaderPositions) {
      if (!p.markPrice || p.markPrice <= 0) {
        try {
          const mp = await binanceClient.getSymbolPrice(p.symbol);
          if (mp > 0) p.markPrice = mp;
        } catch {}
      }
    }

    // Map untuk posisi leader saat ini
    const currentLeaderMap = new Map<string, LeadPosition>();
    for (const p of currentLeaderPositions) {
      const key = `${p.symbol}_${p.positionSide}`;
      currentLeaderMap.set(key, p);
    }

    // 2. Fetch saldo dan posisi akun pengguna (atau virtual jika mode simulasi)
    let userBalance = 0;
    let userBalanceInfo: BalanceInfo;
    let userPositions: UserPosition[] = [];

    if (this.config.paperTrading) {
      userBalance = this.virtualWalletBalance;
      let totalUnrealizedProfit = 0;
      let usedMargin = 0;
      // Sinkronkan mark price & hitung floating PnL untuk posisi simulasi
      for (const [k, vp] of this.virtualPositions.entries()) {
        const lp = currentLeaderMap.get(k);
        let markPrice = lp && lp.markPrice > 0 ? lp.markPrice : 0;
        if (!markPrice) {
          try {
            markPrice = await binanceClient.getSymbolPrice(vp.symbol);
          } catch {}
        }
        if (markPrice > 0) {
          vp.markPrice = markPrice;
          if (lp && (!lp.markPrice || lp.markPrice <= 0)) {
            lp.markPrice = markPrice;
          }
          const qty = Math.abs(vp.positionAmt);
          vp.unRealizedProfit = vp.positionSide === 'LONG'
            ? (vp.markPrice - vp.entryPrice) * qty
            : (vp.entryPrice - vp.markPrice) * qty;
          vp.notional = qty * markPrice;
        }
        totalUnrealizedProfit += (vp.unRealizedProfit || 0);
        usedMargin += ((Math.abs(vp.positionAmt) * (vp.entryPrice || 0)) / (vp.leverage || 10));
      }
      userPositions = Array.from(this.virtualPositions.values());
      userBalanceInfo = {
        totalWalletBalance: this.virtualWalletBalance,
        totalUnrealizedProfit,
        totalMarginBalance: this.virtualWalletBalance + totalUnrealizedProfit,
        availableBalance: Math.max(0, this.virtualWalletBalance - usedMargin),
      };
    } else if (binanceClient.isConfigured()) {
      try {
        const bal = await binanceClient.getAccountBalance();
        userBalance = bal.totalWalletBalance > 0 ? bal.totalWalletBalance : bal.availableBalance;
        userBalanceInfo = bal;
        userPositions = await binanceClient.getOpenPositions();
      } catch (e: any) {
        this.log('WARN', `Gagal ambil saldo/posisi akun pengguna: ${e.message}`);
        userBalanceInfo = {
          totalWalletBalance: 0,
          totalUnrealizedProfit: 0,
          totalMarginBalance: 0,
          availableBalance: 0,
        };
      }
    } else {
      userBalanceInfo = {
        totalWalletBalance: 0,
        totalUnrealizedProfit: 0,
        totalMarginBalance: 0,
        availableBalance: 0,
      };
    }

    const userPositionsMap = new Map<string, UserPosition>();
    for (const up of userPositions) {
      const key = `${up.symbol}_${up.positionSide}`;
      userPositionsMap.set(key, up);
    }
    this.lastUserPositionsCount = userPositions.length;

    // Evaluasi status Mode Libur Akhir Pekan (Waktu China CST UTC+8)
    const weekendStatus = this.getWeekendBreakStatus(userPositions.length);
    if (this.config.weekendBreak?.enabled) {
      if (weekendStatus.isHolidayActive) {
        if (!this.isHolidayActive) {
          this.isHolidayActive = true;
          this.log('INFO', `🌴 [LIBUR AKHIR PEKAN] Seluruh posisi bersih (0 posisi terbuka). Bot memasuki Mode Libur Akhir Pekan (Waktu China: ${weekendStatus.cstTimeStr}). Polling dialihkan ke mode standby (${this.config.weekendBreak.standbyIntervalSec || 60}s) hingga ${weekendStatus.resumeTimeStr}.`);
          this.sendTelegramRateLimited('WEEKEND_ENTER', `🌴 <b>[MODE LIBUR AKHIR PEKAN AKTIF]</b>\n\nSeluruh posisi akun Anda bersih (0 posisi terbuka).\nSesuai jadwal Waktu China (CST, UTC+8), bot beristirahat hemat kuota hingga <b>${weekendStatus.resumeTimeStr}</b>.`);
        }
      } else if (this.isHolidayActive && !weekendStatus.isWeekendCST) {
        this.isHolidayActive = false;
        this.log('SUCCESS', `🌅 [PASAR BUKA] Akhir pekan telah berakhir (Waktu China: ${weekendStatus.cstTimeStr}). Mode Libur Akhir Pekan selesai! Copy trade kembali aktif normal.`);
        this.sendTelegramRateLimited('WEEKEND_EXIT', `🌅 <b>[COPY TRADE KEMBALI AKTIF]</b>\n\nAkhir pekan telah berakhir. Bot copy trade telah kembali aktif penuh memantau transaksi leader.`);
      }
    }

    // 3. Deteksi Transaksi (Mendukung Public Positions & Private Positions / Latest Records)
    if (leaderDetail.positionShow === false) {
      // =========================================================================
      // MODE PRIVATE POSITIONS: Leader menyembunyikan tab Positions dari publik.
      // Bot otomatis beralih memantau feed order stream (Tab 'Latest Records')!
      // =========================================================================
      const orders = leaderDetail.orders || [];
      if (orders.length > 0) {
        if (this.lastProcessedOrderTime === 0) {
          // Cold Start baseline: catat order terakhir sebagai titik nol
          this.lastProcessedOrderTime = orders[0].orderTime;
          this.log('INFO', `🔒 Mode Private Positions Aktif pada Leader. Baseline Latest Records diset pada timestamp: ${new Date(this.lastProcessedOrderTime).toLocaleTimeString('id-ID')}. Bot siap mengeksekusi order baru begitu Leader bertransaksi!`);
        } else {
          // Filter order yang benar-benar baru terjadi setelah baseline
          const newOrders = orders
            .filter((o) => o.orderTime > this.lastProcessedOrderTime)
            .sort((a, b) => a.orderTime - b.orderTime); // urutkan kronologis dari lama ke baru

          for (const ord of newOrders) {
            this.lastProcessedOrderTime = Math.max(this.lastProcessedOrderTime, ord.orderTime);

            if (ord.action === 'OPEN') {
              this.log('INFO', `🔥 [Latest Records] Leader MEMBUKA ${ord.positionSide} ${ord.symbol} @ $${ord.avgPrice} (Vol: ${ord.executedQty})`);
              const posKey = `${ord.symbol}_${ord.positionSide}`;
              const existingStream = this.streamLeaderPositions.get(posKey);
              let leaderAvg = 0;
              if (existingStream) {
                const counts = this.positionAvgCounts.get(posKey) || { leader: 0, user: 0 };
                counts.leader = (counts.leader || 0) + 1;
                this.positionAvgCounts.set(posKey, counts);
                leaderAvg = counts.leader;

                const oldQty = existingStream.amount;
                const newQty = oldQty + ord.executedQty;
                const newEntry = (oldQty * existingStream.entryPrice + ord.executedQty * ord.avgPrice) / newQty;
                existingStream.amount = newQty;
                existingStream.entryPrice = newEntry;
                existingStream.notional = newQty * ord.avgPrice;
                existingStream.updateTime = ord.orderTime;
                existingStream.avgCount = leaderAvg;
              } else {
                if (!this.positionAvgCounts.has(posKey)) {
                  this.positionAvgCounts.set(posKey, { leader: 0, user: 0 });
                }
                this.streamLeaderPositions.set(posKey, {
                  symbol: ord.symbol,
                  positionSide: ord.positionSide,
                  amount: ord.executedQty,
                  entryPrice: ord.avgPrice,
                  markPrice: ord.avgPrice,
                  leverage: 10,
                  marginType: 'CROSSED',
                  unrealizedProfit: 0,
                  notional: ord.executedQty * ord.avgPrice,
                  updateTime: ord.orderTime,
                  avgCount: 0,
                });
              }
              this.saveVirtualState();

              const mockPos: LeadPosition = {
                symbol: ord.symbol,
                positionSide: ord.positionSide,
                amount: ord.executedQty,
                entryPrice: ord.avgPrice,
                markPrice: ord.avgPrice,
                leverage: 10,
                marginType: 'CROSSED',
                unrealizedProfit: 0,
                notional: ord.executedQty * ord.avgPrice,
                avgCount: leaderAvg,
              };
              await this.handleNewPosition(mockPos, userBalance, userPositionsMap.get(`${ord.symbol}_${ord.positionSide}`));
            } else if (ord.action === 'CLOSE') {
              const key = `${ord.symbol}_${ord.positionSide}`;
              const userPos = userPositionsMap.get(key);
              if (userPos && Math.abs(userPos.positionAmt) > 0) {
                const userCurrentQty = Math.abs(userPos.positionAmt);
                const filter = await binanceClient.getSymbolFilter(ord.symbol);

                // Hitung kuantitas tutup proporsional
                const leaderEquity = this.lastLeaderEquity > 0 ? this.lastLeaderEquity : 50000;
                const equityRatio = (userBalance / leaderEquity) * this.config.ratioMultiplier;
                let targetCloseQty = ord.executedQty > 0 ? (ord.executedQty * equityRatio) : userCurrentQty;
                targetCloseQty = binanceClient.roundQuantity(targetCloseQty, filter.stepSize);

                // Jika target tutup di bawah minimal lot koin, lewati agar tidak melikuidasi seluruh posisi akun
                if (targetCloseQty < filter.minQty) {
                  this.log('INFO', `🎯 [Latest Records] Partial close ${ord.symbol} ${ord.positionSide} dilewati karena kuantitas (${targetCloseQty}) di bawah batas minimum Binance (${filter.minQty}).`);
                  continue;
                }

                const isFullClose = targetCloseQty >= userCurrentQty || (userCurrentQty - targetCloseQty) < filter.minQty;
                const actualCloseQty = isFullClose ? userCurrentQty : targetCloseQty;
                const pnl = ord.positionSide === 'LONG'
                  ? (ord.avgPrice - userPos.entryPrice) * actualCloseQty
                  : (userPos.entryPrice - ord.avgPrice) * actualCloseQty;
                const pnlPct = userPos.entryPrice > 0
                  ? ((ord.avgPrice - userPos.entryPrice) / userPos.entryPrice) * (ord.positionSide === 'LONG' ? 1 : -1) * 100 * (userPos.leverage || 10)
                  : 0;

                if (isFullClose) {
                  this.streamLeaderPositions.delete(key);
                  this.positionAvgCounts.delete(key);
                  this.saveVirtualState();
                  this.log('INFO', `🎯 [Latest Records] Leader MENUTUP ${ord.positionSide} ${ord.symbol} @ $${ord.avgPrice} (Tutup Penuh)`);
                  if (this.config.paperTrading) {
                    this.virtualWalletBalance += pnl;
                    this.virtualPositions.delete(key);
                    this.saveVirtualState();
                    this.log('SUCCESS', `🧪 [MODE SIMULASI] Posisi ${ord.symbol} ${ord.positionSide} ditutup penuh sinkron! PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDT (Saldo virtual: $${this.virtualWalletBalance.toFixed(2)} USDT)`);
                  } else {
                    await binanceClient.closePosition(ord.symbol, ord.positionSide, actualCloseQty);
                    this.log('SUCCESS', `✅ Posisi ${ord.symbol} ${ord.positionSide} akun Anda berhasil ditutup penuh.`);
                  }

                  this.recordClosedTrade({
                    symbol: ord.symbol,
                    positionSide: ord.positionSide,
                    action: 'FULL_CLOSE',
                    qty: actualCloseQty,
                    entryPrice: userPos.entryPrice,
                    closePrice: ord.avgPrice,
                    realizedPnl: Number(pnl.toFixed(2)),
                    pnlPct: Number(pnlPct.toFixed(2)),
                    isPaper: this.config.paperTrading,
                  });
                } else {
                  const existingStream = this.streamLeaderPositions.get(key);
                  if (existingStream) {
                    existingStream.amount = Math.max(0, existingStream.amount - ord.executedQty);
                    if (existingStream.amount === 0) {
                      this.streamLeaderPositions.delete(key);
                    }
                    this.saveVirtualState();
                  }
                  this.log('INFO', `🎯 [Latest Records] Leader PARTIAL CLOSE ${ord.positionSide} ${ord.symbol} @ $${ord.avgPrice} (Tutup ${actualCloseQty})`);
                  if (this.config.paperTrading) {
                    const remainingQty = userCurrentQty - actualCloseQty;
                    this.virtualWalletBalance += pnl;
                    userPos.positionAmt = ord.positionSide === 'LONG' ? remainingQty : -remainingQty;
                    userPos.notional = remainingQty * ord.avgPrice;
                    userPos.margin = (remainingQty * (userPos.entryPrice || ord.avgPrice)) / Math.max(1, userPos.leverage || 10);
                    this.virtualPositions.set(key, userPos);
                    this.saveVirtualState();
                    this.log('SUCCESS', `🧪 [MODE SIMULASI] Partial close ${ord.symbol} selesai (-${actualCloseQty}). PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDT (Sisa: ${remainingQty.toFixed(4)} koin)`);
                  } else {
                    await binanceClient.closePosition(ord.symbol, ord.positionSide, actualCloseQty);
                    this.log('SUCCESS', `✅ Partial close ${ord.symbol} (-${actualCloseQty}) berhasil dieksekusi.`);
                  }

                  this.recordClosedTrade({
                    symbol: ord.symbol,
                    positionSide: ord.positionSide,
                    action: 'PARTIAL_CLOSE',
                    qty: actualCloseQty,
                    entryPrice: userPos.entryPrice,
                    closePrice: ord.avgPrice,
                    realizedPnl: Number(pnl.toFixed(2)),
                    pnlPct: Number(pnlPct.toFixed(2)),
                    isPaper: this.config.paperTrading,
                  });
                }
              }
            }
          }
        }
      }

      // Sinkronisasi posisi leader aktif dari order stream dengan posisi akun user
      for (const up of userPositions) {
        const key = `${up.symbol}_${up.positionSide}`;
        if (!this.streamLeaderPositions.has(key)) {
          const matchOrd = orders.find(
            (o) => o.symbol === up.symbol && o.positionSide === up.positionSide && o.action === 'OPEN' && o.avgPrice > 0
          );
          if (matchOrd) {
            this.streamLeaderPositions.set(key, {
              symbol: matchOrd.symbol,
              positionSide: matchOrd.positionSide,
              amount: matchOrd.executedQty,
              entryPrice: matchOrd.avgPrice,
              markPrice: up.markPrice || matchOrd.avgPrice,
              leverage: up.leverage || 10,
              marginType: 'CROSSED',
              unrealizedProfit: 0,
              notional: matchOrd.executedQty * (up.markPrice || matchOrd.avgPrice),
              updateTime: matchOrd.orderTime,
            });
          }
        }
      }

      // Bersihkan posisi stream jika akun user sudah tidak memiliki posisi pada koin tersebut
      for (const key of this.streamLeaderPositions.keys()) {
        if (!userPositionsMap.has(key)) {
          this.streamLeaderPositions.delete(key);
        }
      }
      this.saveVirtualState();

      // Sinkronkan mark price & hitung floating PnL untuk streamLeaderPositions
      for (const slp of this.streamLeaderPositions.values()) {
        try {
          const mp = await binanceClient.getSymbolPrice(slp.symbol);
          if (mp > 0) {
            slp.markPrice = mp;
            slp.unrealizedProfit = slp.positionSide === 'LONG'
              ? (mp - slp.entryPrice) * slp.amount
              : (slp.entryPrice - mp) * slp.amount;
            slp.notional = slp.amount * mp;
          }
        } catch {}
      }

      currentLeaderPositions = Array.from(this.streamLeaderPositions.values());
      leaderDetail.positions = currentLeaderPositions;
      for (const p of currentLeaderPositions) {
        currentLeaderMap.set(`${p.symbol}_${p.positionSide}`, p);
      }
    } else {
      // =========================================================================
      // MODE PUBLIC POSITIONS: Leader membuka tab Positions untuk publik.
      // Bot menggunakan Delta State Machine presisi tinggi.
      // =========================================================================
      if (this.isFirstTick) {
        this.isFirstTick = false;
        this.lastLeaderPositions = new Map(currentLeaderMap);
        this.log('INFO', `📡 [BASELINE COLD START] Sinkronisasi ${currentLeaderMap.size} posisi aktif leader sebagai baseline. Bot siap mengeksekusi order baru begitu leader bertransaksi!`);
      } else {
        for (const [key, leaderPos] of currentLeaderMap.entries()) {
          const prevLeaderPos = this.lastLeaderPositions.get(key);

          if (!prevLeaderPos) {
            // POSISI BARU DIBUKA OLEH LEADER
            this.log('INFO', `🔥 DETEKSI POSISI BARU: Leader membuka ${leaderPos.positionSide} ${leaderPos.symbol} @ $${leaderPos.entryPrice} (Vol: ${leaderPos.amount})`);
            await this.handleNewPosition(leaderPos, userBalance, userPositionsMap.get(key));
          } else {
            // POSISI SUDAH ADA SEBELUMNYA: Cek apakah leader menambah posisi (Averaging) atau partial close
            const deltaAmount = leaderPos.amount - prevLeaderPos.amount;
            const deltaPct = prevLeaderPos.amount > 0 ? deltaAmount / prevLeaderPos.amount : 0;

            if (deltaAmount > 0 && deltaPct >= 0.04) {
              // Leader Menambah Posisi (Averaging Down / Scaling In)
              this.log('INFO', `📈 LEADER MENAMBAH POSISI: ${leaderPos.symbol} ${leaderPos.positionSide} (+${deltaAmount.toFixed(4)} koin, +${(deltaPct * 100).toFixed(1)}%)`);
              await this.handleAveraging(leaderPos, deltaAmount, prevLeaderPos.amount, userBalance, userPositionsMap.get(key));
            } else if (deltaAmount < 0 && Math.abs(deltaPct) >= 0.04) {
              // Leader Partial Close
              this.log('INFO', `📉 LEADER PARTIAL CLOSE: ${leaderPos.symbol} ${leaderPos.positionSide} (-${Math.abs(deltaAmount).toFixed(4)} koin)`);
              await this.handlePartialClose(leaderPos, Math.abs(deltaAmount), prevLeaderPos.amount, userPositionsMap.get(key));
            }
          }
        }

        // Deteksi FULL CLOSE (Posisi sebelumnya ada tapi sekarang hilang dari leader)
        for (const [key, prevLeaderPos] of this.lastLeaderPositions.entries()) {
          if (!currentLeaderMap.has(key)) {
            this.log('INFO', `🎯 LEADER MENUTUP POSISI: ${prevLeaderPos.symbol} ${prevLeaderPos.positionSide}. Menutup posisi akun pengguna...`);
            const userPos = userPositionsMap.get(key);
            if (userPos && Math.abs(userPos.positionAmt) > 0) {
              await this.handleFullClose(prevLeaderPos, userPos);
            } else {
              this.log('INFO', `Akun Anda sudah tidak memiliki posisi aktif di ${prevLeaderPos.symbol}`);
            }
          }
        }
      }
    }

    // 5. Emergency Stop Loss Check
    if (this.config.emergencySlPct > 0 && userBalance > 0) {
      for (const up of userPositions) {
        if (up.unRealizedProfit < 0) {
          const lossPct = (Math.abs(up.unRealizedProfit) / userBalance) * 100;
          if (lossPct >= this.config.emergencySlPct) {
            this.log('ERROR', `🚨 EMERGENCY STOP LOSS DIPICU! ${up.symbol} floating loss: -${lossPct.toFixed(2)}% (Batas: ${this.config.emergencySlPct}%). Menutup posisi darurat!`);
            const side: 'LONG' | 'SHORT' = up.positionAmt > 0 ? 'LONG' : 'SHORT';
            const slQty = Math.abs(up.positionAmt);
            const slPnl = up.unRealizedProfit;

            if (this.config.paperTrading) {
              const posKey = `${up.symbol}_${side}`;
              this.virtualWalletBalance += slPnl;
              this.virtualPositions.delete(posKey);
              this.saveVirtualState();
              this.log('SUCCESS', `🧪 [MODE SIMULASI] Posisi virtual ${up.symbol} ditutup via Emergency Stop Loss! PnL: -$${Math.abs(slPnl).toFixed(2)} USDT`);
            } else {
              try {
                await binanceClient.closePosition(up.symbol, side, slQty);
                this.log('SUCCESS', `✅ Berhasil menutup darurat ${up.symbol}`);
              } catch (e: any) {
                this.log('ERROR', `Gagal menutup darurat ${up.symbol}: ${e.message}`);
              }
            }

            this.recordClosedTrade({
              symbol: up.symbol,
              positionSide: side,
              action: 'EMERGENCY_SL',
              qty: slQty,
              entryPrice: up.entryPrice,
              closePrice: up.markPrice || up.entryPrice,
              realizedPnl: Number(slPnl.toFixed(2)),
              pnlPct: Number((-lossPct).toFixed(2)),
              isPaper: this.config.paperTrading,
            });
          }
        }
      }
    }

    // Update snapshot posisi & data leader
    this.lastLeaderPositions = currentLeaderMap;
    this.lastLeaderDetail = leaderDetail;

    // Pasang avgCount ke posisi leader dan user sebelum broadcast
    for (const lp of currentLeaderPositions) {
      const counts = this.positionAvgCounts.get(`${lp.symbol}_${lp.positionSide}`);
      lp.avgCount = counts?.leader || 0;
    }
    for (const up of userPositions) {
      const counts = this.positionAvgCounts.get(`${up.symbol}_${up.positionSide}`);
      up.avgCount = counts?.user || 0;
    }

    // Broadcast update ke UI dashboard via WebSocket
    if (this.wsBroadcaster) {
      this.wsBroadcaster('TICK', {
        status: this.getStatus(),
        leader: {
          nickname: leaderDetail.nickname,
          avatarUrl: leaderDetail.avatarUrl,
          totalEquity: leaderDetail.totalEquity,
          roi7d: leaderDetail.roi7d,
          mdd7d: leaderDetail.mdd7d,
          winRate: leaderDetail.winRate,
          followerCount: leaderDetail.followerCount,
          maxFollowerCount: leaderDetail.maxFollowerCount,
          positionShow: leaderDetail.positionShow,
          positions: currentLeaderPositions,
          orders: leaderDetail.orders || [],
        },
        user: {
          balance: userBalanceInfo,
          positions: userPositions,
          closedTrades: this.closedTrades,
        },
      });
    }
  }

  private async handleNewPosition(leaderPos: LeadPosition, userBalance: number, existingUserPos?: UserPosition) {
    // 0. Proteksi Mode Libur Akhir Pekan (Waktu China CST UTC+8)
    const isAveragingDown = Boolean(existingUserPos && Math.abs(existingUserPos.positionAmt) > 0);
    const weekendStatus = this.getWeekendBreakStatus();

    // Cek apakah ini Smart Re-Entry pada koin yang baru saja ditutup / kena SL
    const reEntryWindowMs = (this.config.weekendBreak?.reEntryWindowMinutes || 30) * 60 * 1000;
    const recentClose = this.recentlyClosedCoins.get(leaderPos.symbol);
    const isSmartReEntry = Boolean(
      this.config.weekendBreak?.smartReEntryEnabled !== false &&
      recentClose &&
      (Date.now() - recentClose.closedAt) <= reEntryWindowMs
    );

    if (this.config.weekendBreak?.enabled && weekendStatus.isWeekendCST && this.config.weekendBreak.blockNewTrades !== false) {
      if (isAveragingDown) {
        this.log('INFO', `⚡ [LIBUR AKHIR PEKAN - AVG DOWN] Leader menambah muatan (Averaging Down) pada ${leaderPos.symbol} ${leaderPos.positionSide} yang SEDANG TERBUKA. Eksekusi penambahan posisi TETAP DILANJUTKAN untuk mengawal posisi aktif.`);
      } else if (isSmartReEntry) {
        const elapsedMins = Math.max(1, Math.round((Date.now() - (recentClose?.closedAt || Date.now())) / 60000));
        this.log('SUCCESS', `🎯 [SMART RE-ENTRY WEEKEND] Leader membuka kembali ${leaderPos.symbol} ${leaderPos.positionSide} (${elapsedMins} menit setelah posisi sebelumnya ditutup). Eksekusi RE-ENTRY DIIZINKAN untuk mengawal strategi pemulihan leader!`);
        this.sendTelegram(
          `🎯 <b>ORDER SMART RE-ENTRY DIIZINKAN [AKHIR PEKAN]</b>\n\n` +
          `🪙 Simbol: <b>${leaderPos.symbol}</b> (${leaderPos.positionSide})\n` +
          `⏱️ Waktu Jeda: <b>${elapsedMins} menit</b> setelah penutupan sebelumnya.\n` +
          `ℹ️ Eksekusi recovery trade dijalankan otomatis sesuai strategi leader.`
        );
        this.recentlyClosedCoins.delete(leaderPos.symbol);
      } else {
        this.log('INFO', `🌴 [LIBUR AKHIR PEKAN] Melewatkan pembukaan posisi baru ${leaderPos.symbol} ${leaderPos.positionSide} karena Mode Libur Akhir Pekan aktif (Waktu China: ${weekendStatus.cstTimeStr}) dan akun belum memiliki posisi terbuka pada koin ini.`);
        return;
      }
    }

    if (!this.config.paperTrading && !binanceClient.isConfigured()) {
      this.log('WARN', 'Lewati eksekusi: API Key Binance belum dikonfigurasi di dashboard.');
      return;
    }

    // Validasi Slippage Guard
    if (leaderPos.entryPrice > 0 && leaderPos.markPrice > 0) {
      const slippage = Math.abs((leaderPos.markPrice - leaderPos.entryPrice) / leaderPos.entryPrice) * 100;
      if (slippage > this.config.maxSlippagePct) {
        this.log('WARN', `⚠️ SLIPPAGE TERLALU TINGGI pada ${leaderPos.symbol}: ${slippage.toFixed(2)}% (Maks: ${this.config.maxSlippagePct}%). Melewatkan order agar tidak mengejar harga buruk!`);
        return;
      }
    }

    // Hitung kuantitas target
    const filter = await binanceClient.getSymbolFilter(leaderPos.symbol);
    const markPrice = leaderPos.markPrice > 0 ? leaderPos.markPrice : leaderPos.entryPrice;
    if (markPrice <= 0) return;

    let targetQty = 0;

    if (this.config.mode === 'FIXED_AMOUNT') {
      targetQty = this.config.fixedAmountUsdt / markPrice;
    } else if (this.config.mode === 'FIXED_RATIO') {
      targetQty = (userBalance * 0.05 * this.config.ratioMultiplier) / markPrice;
    } else {
      // RATIO_EQUITY (Default: proporsional modal user / modal leader)
      const leaderEquity = this.lastLeaderEquity > 0 ? this.lastLeaderEquity : 50000;
      const equityRatio = (userBalance / leaderEquity) * this.config.ratioMultiplier;
      targetQty = leaderPos.amount * equityRatio;
    }

    // Terapkan Safety Cap (Maksimal modal margin per koin jika diset > 0)
    const lev = Math.max(1, leaderPos.leverage || 10);
    const estMargin = (targetQty * markPrice) / lev;
    if (this.config.maxModalPerCoin > 0 && estMargin > this.config.maxModalPerCoin) {
      targetQty = (this.config.maxModalPerCoin * lev) / markPrice;
      this.log('INFO', `🛡️ Safety Cap Aktif: Margin ${leaderPos.symbol} dibatasi ke nominal maksimal $${this.config.maxModalPerCoin} USDT`);
    }

    // Normalisasi presisi lot
    targetQty = binanceClient.roundQuantity(targetQty, filter.stepSize);

    // Validasi minimal notional ($5 USDT) dan minimal kuantitas
    if (targetQty < filter.minQty || targetQty * markPrice < filter.minNotional) {
      this.log('WARN', `Kuantitas order ${leaderPos.symbol} (${targetQty}) di bawah batas minimum Binance ($${filter.minNotional} USDT / ${filter.minQty}). Order dibatalkan.`);
      return;
    }

    const side: 'BUY' | 'SELL' = leaderPos.positionSide === 'LONG' ? 'BUY' : 'SELL';

    // Proteksi duplikasi order: Jika akun Anda sudah memiliki posisi terbuka pada simbol & arah ini, lewati pembukaan ganda
    if (existingUserPos && Math.abs(existingUserPos.positionAmt) > 0) {
      this.log('INFO', `ℹ️ Posisi ${leaderPos.symbol} ${leaderPos.positionSide} sudah terbuka aktif di akun Anda. Menghubungkan tracking posisi tanpa membuka order baru.`);
      return;
    }

    // JIKA MODE SIMULASI (PAPER TRADING) AKTIF: Eksekusi secara virtual tanpa API Key & tanpa modal riil
    if (this.config.paperTrading) {
      const posKey = `${leaderPos.symbol}_${leaderPos.positionSide}`;
      const lev = Math.max(1, leaderPos.leverage || 10);
      const estMargin = (targetQty * markPrice) / lev;
      const counts = this.positionAvgCounts.get(posKey) || { leader: 0, user: 0 };
      counts.user = 0;
      this.positionAvgCounts.set(posKey, counts);

      const virtualPos: UserPosition = {
        symbol: leaderPos.symbol,
        positionSide: leaderPos.positionSide,
        positionAmt: leaderPos.positionSide === 'LONG' ? targetQty : -targetQty,
        entryPrice: markPrice,
        markPrice: markPrice,
        unRealizedProfit: 0,
        leverage: lev,
        marginType: leaderPos.marginType || 'CROSSED',
        notional: targetQty * markPrice,
        margin: estMargin,
        avgCount: 0,
      };
      this.virtualPositions.set(posKey, virtualPos);
      this.saveVirtualState();
      this.log('SUCCESS', `🧪 [MODE SIMULASI] Order virtual BERHASIL DIBUKA: ${side} ${targetQty} ${leaderPos.symbol} @ $${markPrice} (Estimasi Margin: $${estMargin.toFixed(2)} USDT, Leverage: ${lev}x)`);
      this.sendTelegram(
        `🚀 <b>ORDER COPY TRADE DIBUKA [🧪 SIMULASI]</b>\n\n` +
        `🪙 Simbol: <b>${leaderPos.symbol}</b>\n` +
        `📊 Arah: <b>${leaderPos.positionSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
        (leaderPos.entryPrice > 0 ? `🎯 Entry Leader: <b>$${leaderPos.entryPrice}</b>\n` : '') +
        `💵 Entry: <b>$${markPrice}</b>\n` +
        `📍 Harga Mark: <b>$${markPrice}</b>\n` +
        `📦 Volume: <b>${targetQty}</b>\n` +
        `⚡ Leverage: <b>${leaderPos.leverage || 10}x (${leaderPos.marginType || 'CROSSED'})</b>\n` +
        `💰 Estimasi Margin: <b>$${estMargin.toFixed(2)} USDT</b>\n` +
        `👤 Target Leader: <code>${this.config.portfolioId}</code>`
      );
      return;
    }

    try {
      // Sinkronisasi leverage jika diaktifkan
      if (this.config.syncLeverage && leaderPos.leverage > 0) {
        await binanceClient.setLeverage(leaderPos.symbol, leaderPos.leverage);
        await binanceClient.setMarginType(leaderPos.symbol, leaderPos.marginType);
      }

      // Eksekusi order buka posisi riil di Binance
      this.log('INFO', `🚀 Mengirim order MARKET: ${side} ${targetQty} ${leaderPos.symbol}...`);
      const orderRes = await binanceClient.placeMarketOrder(leaderPos.symbol, side, targetQty, false);
      this.log('SUCCESS', `✅ Order BERHASIL dieksekusi! ID: ${orderRes.orderId || 'OK'} (${side} ${targetQty} ${leaderPos.symbol})`);
      const estMargin = (targetQty * markPrice) / (leaderPos.leverage || 10);
      const title = isAveragingDown
        ? 'ORDER AVERAGING DOWN [🟢 LIVE FUTURES]'
        : 'ORDER COPY TRADE DIBUKA [🟢 LIVE FUTURES]';
      this.sendTelegram(
        `🚀 <b>${title}</b>\n\n` +
        `🪙 Simbol: <b>${leaderPos.symbol}</b>\n` +
        `📊 Arah: <b>${leaderPos.positionSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
        (leaderPos.entryPrice > 0 ? `🎯 Entry Leader: <b>$${leaderPos.entryPrice}</b>\n` : '') +
        `💵 Entry: <b>$${markPrice}</b>\n` +
        `📍 Harga Mark: <b>$${markPrice}</b>\n` +
        `📦 Volume: <b>${targetQty}</b>\n` +
        `⚡ Leverage: <b>${leaderPos.leverage || 10}x (${leaderPos.marginType || 'CROSSED'})</b>\n` +
        `💰 Estimasi Margin: <b>$${estMargin.toFixed(2)} USDT</b>\n` +
        `👤 Target Leader: <code>${this.config.portfolioId}</code>`
      );
    } catch (e: any) {
      this.log('ERROR', `❌ Gagal eksekusi order ${leaderPos.symbol}: ${e.response?.data?.msg || e.message}`);
    }
  }

  private async handleAveraging(
    leaderPos: LeadPosition,
    deltaAmount: number,
    prevTotalLeaderQty: number,
    userBalance: number,
    existingUserPos?: UserPosition
  ) {
    if (!this.config.paperTrading && !binanceClient.isConfigured()) return;
    if (!existingUserPos) return;

    const userCurrentQty = Math.abs(existingUserPos.positionAmt);
    if (userCurrentQty <= 0) return;

    // Hitung penambahan proporsional
    const addRatio = deltaAmount / prevTotalLeaderQty;
    let addQty = userCurrentQty * addRatio;

    const filter = await binanceClient.getSymbolFilter(leaderPos.symbol);
    const markPrice = leaderPos.markPrice > 0 ? leaderPos.markPrice : leaderPos.entryPrice;

    // Safety Cap check berdasarkan Margin modal
    const lev = Math.max(1, leaderPos.leverage || 10);
    const currentMargin = ((userCurrentQty + addQty) * markPrice) / lev;
    if (this.config.maxModalPerCoin > 0 && currentMargin > this.config.maxModalPerCoin) {
      const maxNotional = this.config.maxModalPerCoin * lev;
      addQty = Math.max(0, (maxNotional - userCurrentQty * markPrice) / markPrice);
      if (addQty <= 0) {
        this.log('WARN', `🛡️ Safety Cap Tercapai untuk ${leaderPos.symbol} (Maks Margin: $${this.config.maxModalPerCoin} USDT). Tidak menambah posisi lagi.`);
        return;
      }
    }

    addQty = binanceClient.roundQuantity(addQty, filter.stepSize);
    if (addQty < filter.minQty || addQty * markPrice < filter.minNotional) {
      return;
    }

    if (this.config.paperTrading) {
      const posKey = `${leaderPos.symbol}_${leaderPos.positionSide}`;
      const counts = this.positionAvgCounts.get(posKey) || { leader: 0, user: 0 };
      counts.leader = (counts.leader || 0) + 1;
      counts.user = (counts.user || 0) + 1;
      this.positionAvgCounts.set(posKey, counts);

      const oldQty = Math.abs(existingUserPos.positionAmt);
      const newQty = oldQty + addQty;
      const newEntry = (oldQty * existingUserPos.entryPrice + addQty * markPrice) / newQty;
      const lev = Math.max(1, existingUserPos.leverage || 10);
      existingUserPos.positionAmt = leaderPos.positionSide === 'LONG' ? newQty : -newQty;
      existingUserPos.entryPrice = newEntry;
      existingUserPos.notional = newQty * markPrice;
      existingUserPos.margin = (newQty * newEntry) / lev;
      existingUserPos.avgCount = counts.user;
      this.virtualPositions.set(posKey, existingUserPos);
      this.saveVirtualState();
      this.log('SUCCESS', `🧪 [MODE SIMULASI] Virtual Averaging Berhasil (ke-${counts.user}x): ${leaderPos.symbol} (+${addQty}, total: ${newQty.toFixed(4)} @ $${newEntry.toFixed(2)})`);
      this.sendTelegram(
        `➕ <b>ORDER AVERAGING DOWN [🧪 SIMULASI]</b>\n\n` +
        `🪙 Simbol: <b>${leaderPos.symbol}</b>\n` +
        `📊 Arah: <b>${leaderPos.positionSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
        `🔄 Averaging Down: <b>ke-${counts.user}x (${counts.user + 1} Layer)</b>\n` +
        `💵 Harga Eksekusi: <b>$${markPrice}</b>\n` +
        `📍 Harga Mark: <b>$${markPrice}</b>\n` +
        `🎯 Entry Price Baru: <b>$${newEntry.toFixed(2)}</b>\n` +
        `📦 Tambahan Volume: <b>+${addQty}</b> (Total: ${newQty.toFixed(4)})\n` +
        `⚡ Leverage: <b>${leaderPos.leverage || 10}x</b>\n` +
        `👤 Target Leader: <code>${this.config.portfolioId}</code>`
      );
      return;
    }

    try {
      const posKey = `${leaderPos.symbol}_${leaderPos.positionSide}`;
      const counts = this.positionAvgCounts.get(posKey) || { leader: 0, user: 0 };
      counts.leader = (counts.leader || 0) + 1;
      counts.user = (counts.user || 0) + 1;
      this.positionAvgCounts.set(posKey, counts);

      const side: 'BUY' | 'SELL' = leaderPos.positionSide === 'LONG' ? 'BUY' : 'SELL';
      this.log('INFO', `➕ Menambah posisi (ke-${counts.user}x) ${leaderPos.symbol} sebanyak ${addQty}...`);
      await binanceClient.placeMarketOrder(leaderPos.symbol, side, addQty, false);
      this.log('SUCCESS', `✅ Berhasil menambah posisi ${leaderPos.symbol} (+${addQty})`);
      this.sendTelegram(
        `➕ <b>ORDER AVERAGING DOWN [🟢 LIVE FUTURES]</b>\n\n` +
        `🪙 Simbol: <b>${leaderPos.symbol}</b>\n` +
        `📊 Arah: <b>${leaderPos.positionSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
        `🔄 Averaging Down: <b>ke-${counts.user}x (${counts.user + 1} Layer)</b>\n` +
        `💵 Harga Pasar: <b>$${markPrice}</b>\n` +
        `📍 Harga Mark: <b>$${markPrice}</b>\n` +
        `📦 Tambahan Volume: <b>+${addQty}</b>\n` +
        `⚡ Leverage: <b>${leaderPos.leverage || 10}x</b>\n` +
        `👤 Target Leader: <code>${this.config.portfolioId}</code>`
      );
    } catch (e: any) {
      this.log('ERROR', `Gagal menambah posisi ${leaderPos.symbol}: ${e.response?.data?.msg || e.message}`);
    }
  }

  private async handlePartialClose(
    leaderPos: LeadPosition,
    closedLeaderAmount: number,
    prevTotalLeaderQty: number,
    existingUserPos?: UserPosition
  ) {
    if (!this.config.paperTrading && !binanceClient.isConfigured()) return;
    if (!existingUserPos) return;

    const userCurrentQty = Math.abs(existingUserPos.positionAmt);
    if (userCurrentQty <= 0) return;

    const closeRatio = closedLeaderAmount / prevTotalLeaderQty;
    let closeQty = userCurrentQty * closeRatio;

    const filter = await binanceClient.getSymbolFilter(leaderPos.symbol);
    closeQty = binanceClient.roundQuantity(closeQty, filter.stepSize);

    if (closeQty < filter.minQty) return;

    let exitPrice = 0;
    try {
      exitPrice = await binanceClient.getSymbolPrice(leaderPos.symbol);
    } catch {}
    if (!exitPrice || exitPrice <= 0) {
      exitPrice = leaderPos.markPrice > 0 ? leaderPos.markPrice : (existingUserPos.markPrice > 0 ? existingUserPos.markPrice : existingUserPos.entryPrice);
    }

    const pnl = existingUserPos.positionSide === 'LONG'
      ? (exitPrice - existingUserPos.entryPrice) * closeQty
      : (existingUserPos.entryPrice - exitPrice) * closeQty;
    const pnlPct = existingUserPos.entryPrice > 0
      ? ((exitPrice - existingUserPos.entryPrice) / existingUserPos.entryPrice) * (existingUserPos.positionSide === 'LONG' ? 1 : -1) * 100 * (existingUserPos.leverage || 10)
      : 0;

    if (this.config.paperTrading) {
      const posKey = `${leaderPos.symbol}_${existingUserPos.positionSide}`;
      const oldQty = Math.abs(existingUserPos.positionAmt);
      const remainingQty = Math.max(0, oldQty - closeQty);
      this.virtualWalletBalance += pnl;
      if (remainingQty <= 0) {
        this.virtualPositions.delete(posKey);
      } else {
        existingUserPos.positionAmt = existingUserPos.positionSide === 'LONG' ? remainingQty : -remainingQty;
        existingUserPos.notional = remainingQty * exitPrice;
        existingUserPos.margin = (remainingQty * (existingUserPos.entryPrice || exitPrice)) / Math.max(1, existingUserPos.leverage || 10);
        this.virtualPositions.set(posKey, existingUserPos);
      }
      this.saveVirtualState();
      this.log('SUCCESS', `🧪 [MODE SIMULASI] Virtual Partial Close: ${leaderPos.symbol} (-${closeQty}). PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDT (Saldo virtual: $${this.virtualWalletBalance.toFixed(2)} USDT)`);
    } else {
      try {
        const side: 'LONG' | 'SHORT' = existingUserPos.positionAmt > 0 ? 'LONG' : 'SHORT';
        this.log('INFO', `✂️ Menutup parsial ${leaderPos.symbol} (${(closeRatio * 100).toFixed(1)}%, Vol: ${closeQty})...`);
        await binanceClient.closePosition(leaderPos.symbol, side, closeQty);
        this.log('SUCCESS', `✅ Sukses partial close ${leaderPos.symbol} (${closeQty})`);
      } catch (e: any) {
        this.log('ERROR', `Gagal partial close ${leaderPos.symbol}: ${e.response?.data?.msg || e.message}`);
      }
    }

    this.recordClosedTrade({
      symbol: leaderPos.symbol,
      positionSide: existingUserPos.positionSide as any,
      action: 'PARTIAL_CLOSE',
      qty: closeQty,
      entryPrice: existingUserPos.entryPrice,
      closePrice: exitPrice,
      realizedPnl: Number(pnl.toFixed(2)),
      pnlPct: Number(pnlPct.toFixed(2)),
      isPaper: this.config.paperTrading,
    });
  }

  private async handleFullClose(leaderPos: LeadPosition, existingUserPos: UserPosition) {
    const qty = Math.abs(existingUserPos.positionAmt);
    const side: 'LONG' | 'SHORT' = existingUserPos.positionAmt > 0 ? 'LONG' : 'SHORT';

    let exitPrice = 0;
    try {
      exitPrice = await binanceClient.getSymbolPrice(existingUserPos.symbol);
    } catch {}
    if (!exitPrice || exitPrice <= 0) {
      exitPrice = existingUserPos.markPrice > 0 ? existingUserPos.markPrice : (leaderPos.markPrice > 0 ? leaderPos.markPrice : existingUserPos.entryPrice);
    }

    const pnl = side === 'LONG'
      ? (exitPrice - existingUserPos.entryPrice) * qty
      : (existingUserPos.entryPrice - exitPrice) * qty;
    const pnlPct = existingUserPos.entryPrice > 0
      ? ((exitPrice - existingUserPos.entryPrice) / existingUserPos.entryPrice) * (side === 'LONG' ? 1 : -1) * 100 * (existingUserPos.leverage || 10)
      : 0;

    if (this.config.paperTrading) {
      const posKey = `${existingUserPos.symbol}_${side}`;
      this.virtualWalletBalance += pnl;
      this.virtualPositions.delete(posKey);
      this.positionAvgCounts.delete(posKey);
      this.saveVirtualState();
      this.log('SUCCESS', `🧪 [MODE SIMULASI] Virtual Posisi ${existingUserPos.symbol} ${side} DITUTUP LENGKAP! PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDT. Saldo simulasi: $${this.virtualWalletBalance.toFixed(2)} USDT`);
    } else {
      const posKey = `${existingUserPos.symbol}_${side}`;
      this.positionAvgCounts.delete(posKey);
      try {
        this.log('INFO', `🚪 Mengirim order Market Close untuk ${existingUserPos.symbol} (Qty: ${qty})...`);
        await binanceClient.closePosition(existingUserPos.symbol, side, qty);
        this.log('SUCCESS', `✅ Posisi ${existingUserPos.symbol} ${side} BERHASIL DITUTUP SEMPURNA!`);
      } catch (e: any) {
        this.log('ERROR', `Gagal menutup posisi ${existingUserPos.symbol}: ${e.response?.data?.msg || e.message}`);
      }
    }

    this.recordClosedTrade({
      symbol: existingUserPos.symbol,
      positionSide: side,
      action: 'FULL_CLOSE',
      qty,
      entryPrice: existingUserPos.entryPrice,
      closePrice: exitPrice,
      realizedPnl: Number(pnl.toFixed(2)),
      pnlPct: Number(pnlPct.toFixed(2)),
      isPaper: this.config.paperTrading,
    });
  }

  async panicCloseAll(): Promise<string> {
    this.log('WARN', '🚨 TOMBOL PANIC CLOSE DITEKAN! Menutup semua posisi copy-trade aktif...');
    if (this.config.paperTrading) {
      const count = this.virtualPositions.size;
      for (const vp of this.virtualPositions.values()) {
        const side: 'LONG' | 'SHORT' = vp.positionAmt > 0 ? 'LONG' : 'SHORT';
        const qty = Math.abs(vp.positionAmt);
        const pnl = vp.unRealizedProfit || 0;
        const pnlPct = vp.entryPrice > 0 ? (pnl / ((qty * vp.entryPrice) / (vp.leverage || 10))) * 100 : 0;
        this.virtualWalletBalance += pnl;
        this.recordClosedTrade({
          symbol: vp.symbol,
          positionSide: side,
          action: 'PANIC_CLOSE',
          qty,
          entryPrice: vp.entryPrice,
          closePrice: vp.markPrice || vp.entryPrice,
          realizedPnl: Number(pnl.toFixed(2)),
          pnlPct: Number(pnlPct.toFixed(2)),
          isPaper: true,
        });
      }
      this.virtualPositions.clear();
      this.saveVirtualState();
      this.log('SUCCESS', `🧪 [MODE SIMULASI] Berhasil menutup ${count} posisi virtual secara darurat!`);
      return `Berhasil menutup ${count} posisi virtual.`;
    }

    try {
      const positions = await binanceClient.getOpenPositions();
      if (positions.length === 0) {
        return 'Tidak ada posisi terbuka untuk ditutup.';
      }

      let count = 0;
      for (const p of positions) {
        const side: 'LONG' | 'SHORT' = p.positionAmt > 0 ? 'LONG' : 'SHORT';
        const qty = Math.abs(p.positionAmt);
        await binanceClient.closePosition(p.symbol, side, qty);
        this.recordClosedTrade({
          symbol: p.symbol,
          positionSide: side,
          action: 'PANIC_CLOSE',
          qty,
          entryPrice: p.entryPrice,
          closePrice: p.markPrice || p.entryPrice,
          realizedPnl: Number((p.unRealizedProfit || 0).toFixed(2)),
          pnlPct: 0,
          isPaper: false,
        });
        count++;
      }

      this.log('SUCCESS', `✅ Berhasil menutup ${count} posisi terbuka secara darurat!`);
      return `Berhasil menutup ${count} posisi terbuka.`;
    } catch (e: any) {
      this.log('ERROR', `Gagal melakukan panic close: ${e.message}`);
      throw e;
    }
  }

  /**
   * Mengeksekusi order uji coba (Test Trade) untuk memverifikasi apakah pesanan masuk
   */
  async executeTestTrade(params: {
    symbol?: string;
    positionSide?: 'LONG' | 'SHORT';
    amountUsdt?: number;
    bypassWeekend?: boolean;
  }): Promise<{ success: boolean; message: string; blockedByWeekend?: boolean; isPaper?: boolean; position?: any; order?: any }> {
    const symbol = (params.symbol || 'BTCUSDT').toUpperCase();
    const positionSide: 'LONG' | 'SHORT' = params.positionSide === 'SHORT' ? 'SHORT' : 'LONG';
    const bypassWeekend = Boolean(params.bypassWeekend);
    const amountUsdt = params.amountUsdt && params.amountUsdt >= 5 ? params.amountUsdt : (this.config.fixedAmountUsdt || 25);

    // 1. Validasi proteksi Libur Akhir Pekan (jika tidak dibypass)
    if (!bypassWeekend) {
      const weekendStatus = this.getWeekendBreakStatus();
      if (this.config.weekendBreak?.enabled && weekendStatus.isWeekendCST && this.config.weekendBreak.blockNewTrades !== false) {
        this.log('WARN', `🌴 [TEST ORDER DITOLAK] Order uji coba ${symbol} ${positionSide} diblokir oleh Mode Libur Akhir Pekan (Waktu China: ${weekendStatus.cstTimeStr}). Sistem berjalan normal menolak order baru saat libur!`);
        return {
          success: false,
          blockedByWeekend: true,
          message: `Order uji coba ${symbol} ${positionSide} DITOLAK oleh Mode Libur Akhir Pekan (Waktu China: ${weekendStatus.cstTimeStr}). Sistem bekerja dengan benar mengamankan akun dari trading akhir pekan! Centang opsi "Bypass Libur Akhir Pekan" jika ingin memaksa order masuk.`,
        };
      }
    }

    // 2. Ambil harga mark price & filter ukuran lot
    let markPrice = await binanceClient.getSymbolPrice(symbol);
    if (!markPrice || markPrice <= 0) {
      markPrice = symbol.includes('BTC') ? 65000 : (symbol.includes('ETH') ? 3200 : 150);
    }

    const filter = await binanceClient.getSymbolFilter(symbol);
    let targetQty = binanceClient.roundQuantity(amountUsdt / markPrice, filter.stepSize);
    if (targetQty < filter.minQty) {
      targetQty = filter.minQty;
    }
    if (targetQty * markPrice < filter.minNotional) {
      targetQty = binanceClient.roundQuantity((filter.minNotional + 0.5) / markPrice, filter.stepSize);
      if (targetQty < filter.minQty) targetQty = filter.minQty;
    }

    // 3. Eksekusi sesuai mode (Simulasi / Live Binance)
    if (this.config.paperTrading) {
      const posKey = `${symbol}_${positionSide}`;
      const lev = 10;
      const bypassNotice = bypassWeekend ? ' [BYPASS LIBUR]' : '';
      const existing = this.virtualPositions.get(posKey);
      let userPos: UserPosition;

      if (existing && Math.abs(existing.positionAmt) > 0) {
        // Uji coba averaging down (tambah posisi)
        const counts = this.positionAvgCounts.get(posKey) || { leader: 0, user: 0 };
        counts.user = (counts.user || 0) + 1;
        this.positionAvgCounts.set(posKey, counts);

        const oldQty = Math.abs(existing.positionAmt);
        const newQty = oldQty + targetQty;
        const newEntry = (oldQty * existing.entryPrice + targetQty * markPrice) / newQty;
        existing.positionAmt = positionSide === 'LONG' ? newQty : -newQty;
        existing.entryPrice = newEntry;
        existing.markPrice = markPrice;
        existing.notional = newQty * markPrice;
        existing.margin = (newQty * newEntry) / lev;
        existing.avgCount = counts.user;
        this.virtualPositions.set(posKey, existing);
        userPos = existing;
        this.log('SUCCESS', `🧪 [TEST ORDER SIMULASI]${bypassNotice} Averaging Down uji coba ke-${counts.user}x pada ${symbol} ${positionSide} BERHASIL (+${targetQty}, total: ${newQty.toFixed(4)} koin @ $${newEntry.toFixed(2)})!`);
      } else {
        const counts = this.positionAvgCounts.get(posKey) || { leader: 0, user: 0 };
        counts.user = 0;
        this.positionAvgCounts.set(posKey, counts);

        userPos = {
          symbol,
          positionSide,
          positionAmt: positionSide === 'LONG' ? targetQty : -targetQty,
          entryPrice: markPrice,
          markPrice,
          unRealizedProfit: 0,
          leverage: lev,
          marginType: 'CROSSED',
          notional: targetQty * markPrice,
          margin: (targetQty * markPrice) / lev,
          avgCount: 0,
        };
        this.virtualPositions.set(posKey, userPos);
        this.log('SUCCESS', `🧪 [TEST ORDER SIMULASI]${bypassNotice} Posisi uji coba ${symbol} ${positionSide} BERHASIL MASUK (Vol: ${targetQty} koin @ $${markPrice})! Posisi aktif tercatat.`);
      }

      this.saveVirtualState();
      this.lastUserPositionsCount = this.virtualPositions.size;

      if (this.wsBroadcaster) {
        this.wsBroadcaster('TICK', {
          status: this.getStatus(),
          user: {
            balance: {
              totalWalletBalance: this.virtualWalletBalance,
              totalUnrealizedProfit: 0,
              totalMarginBalance: this.virtualWalletBalance,
              availableBalance: Math.max(0, this.virtualWalletBalance - (Math.abs(userPos.positionAmt) * userPos.entryPrice / 10)),
            },
            positions: this.getVirtualPositions(),
            closedTrades: this.closedTrades,
          },
        });
      }

      return {
        success: true,
        isPaper: true,
        message: `✅ Order uji coba ${symbol} ${positionSide} (${targetQty} koin @ $${markPrice}) berhasil masuk ke daftar Posisi Terbuka akun Anda!`,
        position: userPos,
      };
    } else {
      // Live Binance Futures
      if (!binanceClient.isConfigured()) {
        throw new Error('API Key dan Secret Key Binance belum dikonfigurasi di dashboard.');
      }

      try {
        if (this.config.syncLeverage) {
          await binanceClient.setLeverage(symbol, 10);
        }
        const side: 'BUY' | 'SELL' = positionSide === 'LONG' ? 'BUY' : 'SELL';
        this.log('INFO', `🟢 Mengirim order uji coba real ke Binance: ${symbol} ${side} ${targetQty}...`);
        const orderRes = await binanceClient.placeMarketOrder(symbol, side, targetQty, false, positionSide);
        this.log('SUCCESS', `✅ [TEST ORDER LIVE] Order uji coba real ${symbol} ${side} BERHASIL MASUK ke Binance Futures! Order ID: ${orderRes.orderId}`);
        return {
          success: true,
          isPaper: false,
          message: `✅ Order uji coba real ${symbol} ${side} (${targetQty} koin) berhasil masuk ke Binance Futures! Order ID: ${orderRes.orderId}`,
          order: orderRes,
        };
      } catch (err: any) {
        const errMsg = err.response?.data?.msg || err.message;
        this.log('ERROR', `Gagal eksekusi order uji coba di Binance: ${errMsg}`);
        throw new Error(errMsg);
      }
    }
  }
}

export const engine = new CopyTradeEngine();
