import fs from 'fs';
import path from 'path';
import { AppConfig, EngineStatus, LeadPosition, LogEntry, UserPosition, BalanceInfo, ClosedTrade, PollingStatusInfo, LeadPortfolioDetail, WeekendBreakStatus, DailyScheduleConfig, DailyScheduleStatus, DailyBalanceSnapshot, SkippedOrderInfo } from '../types';
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
  private processedOrderKeys: Set<string> = new Set();
  private lastSessionKey: string = '';
  private lastUserPositionsCount: number = 0;
  private isHolidayActive: boolean = false;
  private isHolidayAborted: boolean = false;
  private holidayAbortedReason: string = '';
  private holidayAbortedAt: number = 0;
  private isScheduleSleeping: boolean = false;
  private isScheduleAborted: boolean = false;
  private scheduleAbortedReason: string = '';
  private scheduleAbortedAt: number = 0;
  private lastUserBalance: BalanceInfo | null = null;
  private lastUserPositions: UserPosition[] = [];
  private lastMidnightSnapshotDate: string = '';
  private midnightSchedulerTimer: NodeJS.Timeout | null = null;
  public virtualPositions: Map<string, UserPosition> = new Map();
  public streamLeaderPositions: Map<string, LeadPosition> = new Map();
  public positionAvgCounts: Map<string, { leader: number; user: number }> = new Map();
  public slippageSkippedOrders: Map<string, SkippedOrderInfo> = new Map();
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
        this.config = this.normalizeConfig({ ...this.config, ...dbConfig });
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
        if (Array.isArray(dbVs.slippageSkippedOrders)) {
          this.slippageSkippedOrders = new Map(dbVs.slippageSkippedOrders);
        }
        if (typeof dbVs.lastProcessedOrderTime === 'number' && dbVs.lastProcessedOrderTime > 0) {
          this.lastProcessedOrderTime = dbVs.lastProcessedOrderTime;
        }
        if (Array.isArray(dbVs.processedOrderKeys)) {
          this.processedOrderKeys = new Set(dbVs.processedOrderKeys);
        }
        if (typeof dbVs.isHolidayAborted === 'boolean') {
          this.isHolidayAborted = dbVs.isHolidayAborted;
          this.holidayAbortedReason = dbVs.holidayAbortedReason || '';
          this.holidayAbortedAt = dbVs.holidayAbortedAt || 0;
        }
        if (typeof dbVs.isScheduleAborted === 'boolean') {
          this.isScheduleAborted = dbVs.isScheduleAborted;
          this.scheduleAbortedReason = dbVs.scheduleAbortedReason || '';
          this.scheduleAbortedAt = dbVs.scheduleAbortedAt || 0;
        }
        if (dbVs.lastLeaderDetail) {
          this.lastLeaderDetail = dbVs.lastLeaderDetail;
          this.lastLeaderEquity = this.lastLeaderDetail?.totalEquity || this.lastLeaderEquity;
        }
        if (dbVs.lastUserBalance) {
          this.lastUserBalance = dbVs.lastUserBalance;
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

    // Warmup awal: ambil profil leader dan saldo Binance secara aman di latar belakang jika belum ada
    if (!this.lastLeaderDetail && this.config.portfolioId) {
      scraper.fetchPortfolioDetail(this.config.portfolioId, this.config.proxy).then((detail) => {
        if (detail.isSuccess) {
          this.lastLeaderDetail = detail;
          this.lastLeaderEquity = detail.totalEquity || this.lastLeaderEquity;
          this.saveVirtualState();
        }
      }).catch(() => {});
    }

    if (!this.config.paperTrading && binanceClient.isConfigured() && !this.lastUserBalance) {
      binanceClient.syncTime().then(() => binanceClient.getAccountBalance()).then((bal) => {
        if (bal && (bal.totalWalletBalance > 0 || bal.availableBalance > 0)) {
          this.setLastUserAccount(bal, []);
        }
      }).catch(() => {});
    }

    // 4. Inisialisasi Scheduler Snapshot Saldo Jam 12 Malam (00:00 WIB)
    if (this.midnightSchedulerTimer) {
      clearInterval(this.midnightSchedulerTimer);
    }
    this.midnightSchedulerTimer = setInterval(() => {
      this.checkDailyMidnightSnapshot().catch(() => {});
    }, 30000);

    setTimeout(() => {
      this.checkDailyMidnightSnapshot().catch(() => {});
    }, 5000);
  }

  private saveVirtualState() {
    try {
      const data = {
        virtualWalletBalance: this.virtualWalletBalance,
        virtualPositions: Array.from(this.virtualPositions.entries()),
        streamLeaderPositions: Array.from(this.streamLeaderPositions.entries()),
        positionAvgCounts: Array.from(this.positionAvgCounts.entries()),
        slippageSkippedOrders: Array.from(this.slippageSkippedOrders.entries()),
        lastProcessedOrderTime: this.lastProcessedOrderTime,
        processedOrderKeys: Array.from(this.processedOrderKeys).slice(-500),
        isHolidayAborted: this.isHolidayAborted,
        holidayAbortedReason: this.holidayAbortedReason,
        holidayAbortedAt: this.holidayAbortedAt,
        isScheduleAborted: this.isScheduleAborted,
        scheduleAbortedReason: this.scheduleAbortedReason,
        scheduleAbortedAt: this.scheduleAbortedAt,
        lastLeaderDetail: this.lastLeaderDetail,
        lastUserBalance: this.lastUserBalance,
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
        if (Array.isArray(data.slippageSkippedOrders)) {
          this.slippageSkippedOrders = new Map(data.slippageSkippedOrders);
        }
        if (typeof data.lastProcessedOrderTime === 'number' && data.lastProcessedOrderTime > 0) {
          this.lastProcessedOrderTime = data.lastProcessedOrderTime;
        }
        if (Array.isArray(data.processedOrderKeys)) {
          this.processedOrderKeys = new Set(data.processedOrderKeys);
        }
        if (typeof data.isHolidayAborted === 'boolean') {
          this.isHolidayAborted = data.isHolidayAborted;
          this.holidayAbortedReason = data.holidayAbortedReason || '';
          this.holidayAbortedAt = data.holidayAbortedAt || 0;
        }
        if (typeof data.isScheduleAborted === 'boolean') {
          this.isScheduleAborted = data.isScheduleAborted;
          this.scheduleAbortedReason = data.scheduleAbortedReason || '';
          this.scheduleAbortedAt = data.scheduleAbortedAt || 0;
        }
        if (data.lastLeaderDetail) {
          this.lastLeaderDetail = data.lastLeaderDetail;
          this.lastLeaderEquity = this.lastLeaderDetail?.totalEquity || this.lastLeaderEquity;
        }
        if (data.lastUserBalance) {
          this.lastUserBalance = data.lastUserBalance;
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
      this.slippageSkippedOrders.delete(`${fullTrade.symbol}_${fullTrade.positionSide}`);
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

  public normalizeConfig(raw: Partial<AppConfig>): AppConfig {
    const parsed: any = { ...raw };
    if (!parsed.adminPassword) parsed.adminPassword = 'admin123';
    if (!parsed.jwtSecret) parsed.jwtSecret = Math.random().toString(36).substring(2) + Date.now().toString(36);
    if (parsed.paperTrading === undefined) parsed.paperTrading = true;
    if (parsed.virtualBalanceUsdt === undefined) parsed.virtualBalanceUsdt = 100;
    if (!parsed.weekendBreak) {
      parsed.weekendBreak = {
        enabled: true,
        timezone: 'WIB',
        standbyIntervalSec: 60,
        blockNewTrades: true,
        smartReEntryEnabled: true,
        reEntryWindowMinutes: 30,
        autoAbortOnLeaderTrade: true,
      };
    } else {
      if (parsed.weekendBreak.smartReEntryEnabled === undefined) parsed.weekendBreak.smartReEntryEnabled = true;
      if (parsed.weekendBreak.reEntryWindowMinutes === undefined) parsed.weekendBreak.reEntryWindowMinutes = 30;
      if (parsed.weekendBreak.autoAbortOnLeaderTrade === undefined) parsed.weekendBreak.autoAbortOnLeaderTrade = true;
    }
    if (!parsed.dailySchedule) {
      parsed.dailySchedule = {
        enabled: false,
        startTime: '10:00',
        endTime: '18:30',
        action: 'FULL_STOP',
        guardOpenPositions: true,
      };
    }
    if (parsed.reverseTrading === undefined) parsed.reverseTrading = false;
    if (!parsed.reorderWindowMinutes) parsed.reorderWindowMinutes = 30;
    if (parsed.zeroSlippageOnly === undefined) parsed.zeroSlippageOnly = true;
    if (parsed.sniperPullbackEnabled === undefined) parsed.sniperPullbackEnabled = true;
    if (parsed.ratioMultiplier === undefined) parsed.ratioMultiplier = 1.0;
    if (parsed.fixedAmountUsdt === undefined) parsed.fixedAmountUsdt = 25.0;
    if (parsed.maxModalPerCoin === undefined) parsed.maxModalPerCoin = 0;
    if (parsed.maxSlippagePct === undefined) parsed.maxSlippagePct = 0.5;
    if (parsed.syncLeverage === undefined) parsed.syncLeverage = true;
    if (parsed.emergencySlPct === undefined) parsed.emergencySlPct = 10.0;
    if (!parsed.proxy) parsed.proxy = { enabled: false, host: '', port: 823, username: '', password: '' };
    return parsed as AppConfig;
  }

  private loadConfig(): AppConfig {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        return this.normalizeConfig(parsed);
      }
    } catch (e: any) {
      this.log('WARN', `Gagal memuat config.json, menggunakan default: ${e.message}`);
    }

    return this.normalizeConfig({
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
      reverseTrading: false,
      reorderWindowMinutes: 30,
      zeroSlippageOnly: true,
      sniperPullbackEnabled: true,
      syncLeverage: true,
      emergencySlPct: 10.0,
      pollingIntervalMs: 2500,
    });
  }

  saveConfig(newConfig: Partial<AppConfig>): AppConfig {
    const portfolioChanged = newConfig.portfolioId && newConfig.portfolioId !== this.config.portfolioId;

    this.config = { ...this.config, ...newConfig };

    // Jika target leader diganti, bersihkan tracking posisi lama agar tidak memicu deteksi posisi palsu
    if (portfolioChanged) {
      this.lastLeaderPositions.clear();
      this.lastLeaderEquity = 0;
      this.lastProcessedOrderTime = 0;
      this.processedOrderKeys.clear();
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
    binanceClient.configure(this.config.binanceApiKey, this.config.binanceSecretKey, this.config.isTestnet, this.config.proxy);
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
    this.processedOrderKeys.clear();
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

  getLastUserAccount(): { balance: BalanceInfo | null; positions: UserPosition[] } {
    if (this.config.paperTrading) {
      let totalUnrealizedProfit = 0;
      let usedMargin = 0;
      for (const vp of this.virtualPositions.values()) {
        totalUnrealizedProfit += (vp.unRealizedProfit || 0);
        usedMargin += ((Math.abs(vp.positionAmt) * (vp.entryPrice || 0)) / (vp.leverage || 10));
      }
      return {
        balance: {
          totalWalletBalance: this.virtualWalletBalance,
          totalUnrealizedProfit,
          totalMarginBalance: this.virtualWalletBalance + totalUnrealizedProfit,
          availableBalance: Math.max(0, this.virtualWalletBalance - usedMargin),
        },
        positions: Array.from(this.virtualPositions.values()),
      };
    }
    return {
      balance: this.lastUserBalance,
      positions: this.lastUserPositions,
    };
  }

  setLastUserAccount(balance: BalanceInfo | null, positions: UserPosition[] = []) {
    if (balance && (balance.totalWalletBalance > 0 || balance.availableBalance > 0 || balance.totalMarginBalance > 0)) {
      this.lastUserBalance = balance;
    }
    if (Array.isArray(positions)) {
      this.lastUserPositions = positions;
      this.lastUserPositionsCount = positions.length;
    }
    this.saveVirtualState();
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
            if (lp.markPrice > 0 && lp.entryPrice > 0 && lp.amount > 0) {
              lp.unrealizedProfit = lp.positionSide === 'LONG'
                ? (lp.markPrice - lp.entryPrice) * lp.amount
                : (lp.entryPrice - lp.markPrice) * lp.amount;
              lp.notional = lp.amount * lp.markPrice;
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
   * Mengembalikan waktu WIB (UTC+7) dan status akhir pekan
   */
  getTimes() {
    const now = new Date();
    // UTC time
    const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
    const wibTime = new Date(utcMs + (7 * 3600000));
    const cstTime = new Date(utcMs + (8 * 3600000));

    const daysId = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

    const wibDay = wibTime.getDay(); // 0 = Minggu, 6 = Sabtu
    const isWeekendWIB = (wibDay === 0 || wibDay === 6);

    const wibHh = String(wibTime.getHours()).padStart(2, '0');
    const wibMm = String(wibTime.getMinutes()).padStart(2, '0');
    const wibTimeStr = `${daysId[wibDay]}, ${wibHh}:${wibMm} WIB`;

    const cstDay = cstTime.getDay();
    const cstHh = String(cstTime.getHours()).padStart(2, '0');
    const cstMm = String(cstTime.getMinutes()).padStart(2, '0');
    const cstTimeStr = `${daysId[cstDay]}, ${cstHh}:${cstMm} CST`;

    return {
      wibTime,
      wibDay,
      isWeekendWIB,
      isWeekendCST: isWeekendWIB, // Alias kompatibilitas
      wibTimeStr,
      cstTimeStr,
      cstTime,
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

  /**
   * Mencari posisi aktif user yang berkorespondensi dengan posisi/order leader.
   * Mendukung pencocokan langsung (Direct: misal LONG <-> LONG)
   * maupun pencocokan terbalik jika posisi dibuka dengan mode inverse (Inverse: misal LONG <-> SHORT).
   */
  getUserPositionForLeader(
    symbol: string,
    leaderSide: 'LONG' | 'SHORT',
    userPositionsMap: Map<string, UserPosition>
  ): { userPos: UserPosition | undefined; isReversed: boolean } {
    const isReverseTrading = Boolean(this.config.reverseTrading);
    // Jika Reverse Trading aktif, posisi yang kita cari di akun user adalah sisi kebalikan
    const targetSide = isReverseTrading
      ? (leaderSide === 'LONG' ? 'SHORT' : 'LONG')
      : leaderSide;

    // 1. Cek langsung posisi yang cocok dengan targetSide (Mendukung Hedge Mode: LONG & SHORT berdampingan)
    const directKey = `${symbol}_${targetSide}`;
    const directPos = userPositionsMap.get(directKey);
    if (directPos && Math.abs(directPos.positionAmt) > 0) {
      return { userPos: directPos, isReversed: isReverseTrading };
    }

    // 2. Cek apakah ada posisi dengan mode One-Way bawaan (di mana positionSide adalah 'BOTH')
    const bothPos = userPositionsMap.get(`${symbol}_BOTH`);
    if (bothPos && Math.abs(bothPos.positionAmt) > 0) {
      const bothSide = bothPos.positionAmt > 0 ? 'LONG' : 'SHORT';
      if (bothSide === targetSide) {
        return { userPos: bothPos, isReversed: isReverseTrading };
      }
    }

    return { userPos: undefined, isReversed: false };
  }

  /**
   * Mengembalikan tanggal dalam format "YYYY-MM-DD" pada zona waktu Waktu Indonesia Barat (WIB, UTC+7)
   */
  public getWibDate(dateObj?: Date): string {
    const d = dateObj || new Date();
    const utcEpoch = d.getTime();
    const wibEpoch = utcEpoch + (7 * 3600000);
    const wibDate = new Date(wibEpoch);
    const y = wibDate.getUTCFullYear();
    const m = String(wibDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(wibDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * Mengembalikan tanggal kemarin dalam format "YYYY-MM-DD" pada zona waktu WIB
   */
  public getYesterdayWibDate(): string {
    const d = new Date();
    const yesterdayEpoch = d.getTime() - (24 * 3600000);
    return this.getWibDate(new Date(yesterdayEpoch));
  }

  /**
   * Mengambil snapshot saldo harian dan performa trading, menyimpan ke database dan fallback JSON
   */
  public async takeDailyBalanceSnapshot(targetDate?: string, sendAlert: boolean = false): Promise<DailyBalanceSnapshot> {
    const dateStr = targetDate || this.getWibDate();

    // 1. Dapatkan saldo akun dan posisi user terkini
    const acct = this.getLastUserAccount();
    const walletBalance = Number(acct.balance?.totalWalletBalance || 0);
    const marginBalance = Number(acct.balance?.totalMarginBalance || walletBalance);
    const availableBalance = Number(acct.balance?.availableBalance || walletBalance);
    const unrealizedPnl = Number(acct.balance?.totalUnrealizedProfit || 0);
    const openPositionsCount = acct.positions.length;

    // 2. Filter trade selesai yang terjadi pada tanggal WIB tersebut
    const dayTrades = this.closedTrades.filter((t) => this.getWibDate(new Date(t.timestamp)) === dateStr);
    const tradesCountToday = dayTrades.length;
    let realizedPnlToday = 0;
    let winCountToday = 0;
    let lossCountToday = 0;

    for (const t of dayTrades) {
      realizedPnlToday += Number(t.realizedPnl || 0);
      if (t.realizedPnl >= 0) {
        winCountToday++;
      } else {
        lossCountToday++;
      }
    }

    realizedPnlToday = Math.round(realizedPnlToday * 100) / 100;
    const winRateToday = tradesCountToday > 0 ? Math.round((winCountToday / tradesCountToday) * 1000) / 10 : 0;

    const snapshot: DailyBalanceSnapshot = {
      date: dateStr,
      walletBalance,
      marginBalance,
      availableBalance,
      unrealizedPnl,
      realizedPnlToday,
      tradesCountToday,
      winCountToday,
      lossCountToday,
      winRateToday,
      openPositionsCount,
      timestamp: Date.now(),
    };

    await dbService.saveDailySnapshot(snapshot);
    this.log('SUCCESS', `💾 [SNAPSHOT SALDO] Berhasil menyimpan snapshot harian tanggal ${dateStr} (Saldo: $${walletBalance.toFixed(2)}, PnL Hari Itu: ${realizedPnlToday >= 0 ? '+' : ''}$${realizedPnlToday.toFixed(2)})`);

    // 3. Kirim notifikasi Telegram rekap harian jika diminta (otomatis jam 12 malam)
    if (sendAlert) {
      const emojiPnl = snapshot.realizedPnlToday >= 0 ? '🟢' : '🔴';
      const signPnl = snapshot.realizedPnlToday >= 0 ? '+' : '';
      const msg =
        `📊 <b>[REKAP HARIAN SALDO & PERFORMA]</b>\n` +
        `📅 Tanggal: <b>${snapshot.date}</b> (00:00 WIB)\n\n` +
        `💰 <b>Informasi Saldo Akun:</b>\n` +
        `• Total Wallet: <b>$${snapshot.walletBalance.toFixed(2)} USDT</b>\n` +
        `• Total Margin: <b>$${snapshot.marginBalance.toFixed(2)} USDT</b>\n` +
        `• Saldo Tersedia: <b>$${snapshot.availableBalance.toFixed(2)} USDT</b>\n` +
        `• Floating PnL: <b>${snapshot.unrealizedPnl >= 0 ? '+' : ''}$${snapshot.unrealizedPnl.toFixed(2)} USDT</b>\n\n` +
        `📈 <b>Performa Trading Hari Ini:</b>\n` +
        `• Realized PnL: <b>${signPnl}$${snapshot.realizedPnlToday.toFixed(2)} USDT</b> ${emojiPnl}\n` +
        `• Total Selesai: <b>${snapshot.tradesCountToday} trade</b>\n` +
        `• Hasil: <b>${snapshot.winCountToday} Win / ${snapshot.lossCountToday} Loss</b> (Win Rate: <b>${snapshot.winRateToday.toFixed(1)}%</b>)\n` +
        `• Posisi Terbuka: <b>${snapshot.openPositionsCount} posisi</b>\n\n` +
        `💾 <i>Snapshot saldo telah otomatis disimpan ke database untuk pelacakan performa.</i>`;
      this.sendTelegram(msg);
    }

    return snapshot;
  }

  /**
   * Pengecekan otomatis tengah malam (00:00 WIB) untuk rekap saldo harian
   */
  public async checkDailyMidnightSnapshot(): Promise<void> {
    const times = this.getTimes();
    const todayWib = this.getWibDate();
    const yesterdayWib = this.getYesterdayWibDate();

    // Pastikan lastMidnightSnapshotDate terisi dari DB jika masih kosong
    if (!this.lastMidnightSnapshotDate) {
      const existing = await dbService.loadDailySnapshots(1);
      if (existing.length > 0) {
        this.lastMidnightSnapshotDate = existing[0].date;
      }
    }

    // 1. Cek tepat jam 00:00 - 00:05 WIB: Rekap hari kemarin yang baru saja selesai
    if (times.wibHour === 0 && times.wibMinute <= 5) {
      if (this.lastMidnightSnapshotDate !== yesterdayWib) {
        this.lastMidnightSnapshotDate = yesterdayWib;
        this.log('INFO', `🌙 [REKAP TENGAH MALAM] Mengambil snapshot saldo jam 12 malam untuk tanggal ${yesterdayWib} (00:00 WIB)...`);
        await this.takeDailyBalanceSnapshot(yesterdayWib, true);
      }
    } else {
      // 2. Graceful catchup: Jika server baru menyala di siang/sore hari dan hari kemarin belum punya snapshot
      if (this.lastMidnightSnapshotDate !== yesterdayWib && this.lastMidnightSnapshotDate !== todayWib) {
        const recentSnapshots = await dbService.loadDailySnapshots(5);
        const hasYesterday = recentSnapshots.some((s) => s.date === yesterdayWib);
        if (!hasYesterday) {
          this.log('INFO', `🔄 [CATCH-UP SNAPSHOT] Mendeteksi snapshot tanggal kemarin (${yesterdayWib}) belum tercatat. Mengambil snapshot sekarang...`);
          this.lastMidnightSnapshotDate = yesterdayWib;
          await this.takeDailyBalanceSnapshot(yesterdayWib, false);
        }
      }
    }
  }

  /**
   * Mengambil daftar riwayat snapshot harian dari database/JSON
   */
  public async getDailySnapshots(days: number = 60): Promise<DailyBalanceSnapshot[]> {
    return await dbService.loadDailySnapshots(days);
  }

  getWeekendBreakStatus(overridePositionsCount?: number): WeekendBreakStatus {
    const times = this.getTimes();
    const isWeekend = times.isWeekendWIB;
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

    // Libur aktif HANYA jika enabled, akhir pekan WIB, tidak ada posisi terbuka, di luar re-entry window, DAN belum dibatalkan oleh transaksi leader
    const isHolidayActive = Boolean(cfg?.enabled && isWeekend && !hasOpenPositions && !inReEntryWindow && !this.isHolidayAborted);

    return {
      isWeekendWIB: isWeekend,
      isWeekendCST: isWeekend, // Alias kompatibilitas
      hasOpenPositions,
      isHolidayActive,
      inReEntryWindow,
      reEntryRemainingMins,
      isHolidayAborted: this.isHolidayAborted,
      abortedReason: this.holidayAbortedReason,
      abortedAt: this.holidayAbortedAt,
      wibTimeStr: times.wibTimeStr,
      cstTimeStr: times.cstTimeStr,
      resumeTimeStr: 'Senin 00:00 WIB',
    };
  }

  /**
   * Membatalkan Mode Libur Akhir Pekan seketika jika polling mendeteksi transaksi leader.
   */
  public abortWeekendHoliday(reason: string, details?: string) {
    if (this.isHolidayAborted) return;

    this.isHolidayAborted = true;
    this.isHolidayActive = false;
    this.holidayAbortedReason = reason;
    this.holidayAbortedAt = Date.now();
    this.saveVirtualState();

    const times = this.getTimes();
    const timeStr = `${times.wibTimeStr}`;

    this.log('WARN', `🚨 [LEADER AKTIF DI AKHIR PEKAN] Terdeteksi transaksi (${reason}) dari Leader saat mode libur akhir pekan! Mode libur otomatis DIBATALKAN. Bot kembali ke mode aktif penuh untuk menyalin trade!`);

    this.sendTelegram(
      `🚨 <b>[LEADER AKTIF DI AKHIR PEKAN - LIBUR DIBATALKAN]</b>\n\n` +
      `Terdeteksi transaksi baru dari Leader saat bot berada di mode libur akhir pekan:\n` +
      `⚡ <b>${reason}</b>\n` +
      (details ? `ℹ️ Detail: <code>${details}</code>\n` : '') +
      `🕒 Waktu: <b>${timeStr}</b>\n\n` +
      `🟢 <b>TINDAKAN OTOMATIS:</b>\n` +
      `1. Mode libur akhir pekan otomatis <b>DIBATALKAN</b>.\n` +
      `2. Polling standby (60s) langsung dikembalikan ke <b>kecepatan penuh (1-1.5s)</b>.\n` +
      `3. Transaksi Leader langsung <b>disalin / dieksekusi</b> (atau masuk antrean Auto-Sniper jika harga sempat bergeser)!`
    );

    if (this.wsBroadcaster) {
      this.wsBroadcaster('TICK', {
        status: this.getStatus(),
      });
    }
  }

  /**
   * Reset status pembatalan libur akhir pekan secara manual.
   */
  public resetWeekendHoliday() {
    this.isHolidayAborted = false;
    this.holidayAbortedReason = '';
    this.holidayAbortedAt = 0;
    this.saveVirtualState();
    this.log('INFO', '🌴 Status pembatalan libur akhir pekan telah di-reset. Mode libur dapat aktif kembali jika tidak ada posisi terbuka.');
    if (this.wsBroadcaster) {
      this.wsBroadcaster('TICK', {
        status: this.getStatus(),
      });
    }
  }

  /**
   * Membatalkan Jadwal Istirahat Harian seketika jika polling mendeteksi transaksi leader.
   */
  public abortDailySchedule(reason: string, details?: string) {
    if (this.isScheduleAborted) return;

    this.isScheduleAborted = true;
    this.isScheduleSleeping = false;
    this.scheduleAbortedReason = reason;
    this.scheduleAbortedAt = Date.now();
    this.saveVirtualState();

    this.log('WARN', `🚨 [JADWAL ISTIRAHAT DIBATALKAN - BOT BANGUN] Leader bertransaksi: ${reason}! Mode istirahat seketika dihentikan. Bot BANGUN & KEMBALI AKTIF PENUH!`);

    this.sendTelegram(
      `🚨 <b>[JADWAL ISTIRAHAT DIBATALKAN - BOT BANGUN]</b>\n\n` +
      `Terdeteksi transaksi baru dari Leader saat bot dalam mode istirahat:\n` +
      `⚡ <b>${reason}</b>\n` +
      (details ? `ℹ️ Detail: <code>${details}</code>\n\n` : '\n') +
      `🟢 <b>TINDAKAN OTOMATIS:</b>\n` +
      `1. Mode istirahat harian seketika <b>DIBATALKAN</b>.\n` +
      `2. Polling standby dikembalikan ke <b>kecepatan penuh</b>.\n` +
      `3. Transaksi Leader langsung <b>disalin / dieksekusi</b> ke akun Anda!`
    );

    if (this.wsBroadcaster) {
      this.wsBroadcaster('TICK', {
        status: this.getStatus(),
        leader: this.getLastLeaderDetail(),
        user: this.getLastUserAccount(),
      });
    }
  }

  /**
   * Reset status pembatalan jadwal istirahat secara manual.
   */
  public resetDailyScheduleAbort() {
    this.isScheduleAborted = false;
    this.scheduleAbortedReason = '';
    this.scheduleAbortedAt = 0;
    this.saveVirtualState();
    this.log('INFO', '🕒 Status pembatalan jadwal istirahat telah di-reset. Bot dapat tidur kembali sesuai jadwal.');
    if (this.wsBroadcaster) {
      this.wsBroadcaster('TICK', {
        status: this.getStatus(),
        leader: this.getLastLeaderDetail(),
        user: this.getLastUserAccount(),
      });
    }
  }

  /**
   * Mengembalikan status Jadwal Istirahat Harian (Sleep Schedule)
   */
  public getDailyScheduleStatus(overridePositionsCount?: number): DailyScheduleStatus {
    const cfg = this.config.dailySchedule;
    if (!cfg || !cfg.enabled) {
      return {
        enabled: false,
        isSleeping: false,
        startTime: cfg?.startTime || '10:00',
        endTime: cfg?.endTime || '18:30',
        action: cfg?.action || 'FULL_STOP',
        resumeInText: '',
        guardingPositions: false,
        isScheduleAborted: this.isScheduleAborted,
        abortedReason: this.scheduleAbortedReason,
        abortedAt: this.scheduleAbortedAt,
      };
    }

    const times = this.getTimes();
    const currentMins = times.wibHour * 60 + times.wibMinute;

    const [startH, startM] = (cfg.startTime || '10:00').split(':').map((x) => parseInt(x, 10) || 0);
    const [endH, endM] = (cfg.endTime || '18:30').split(':').map((x) => parseInt(x, 10) || 0);
    const startTotalMins = startH * 60 + startM;
    const endTotalMins = endH * 60 + endM;

    let inScheduleWindow = false;
    let diffMinsToResume = 0;

    if (startTotalMins <= endTotalMins) {
      // Rentang waktu dalam hari yang sama (misal 10:00 s/d 18:30)
      inScheduleWindow = currentMins >= startTotalMins && currentMins < endTotalMins;
      if (inScheduleWindow) {
        diffMinsToResume = endTotalMins - currentMins;
      }
    } else {
      // Rentang waktu melewati tengah malam (misal 22:00 s/d 06:00)
      inScheduleWindow = currentMins >= startTotalMins || currentMins < endTotalMins;
      if (inScheduleWindow) {
        if (currentMins >= startTotalMins) {
          diffMinsToResume = (1440 - currentMins) + endTotalMins;
        } else {
          diffMinsToResume = endTotalMins - currentMins;
        }
      }
    }

    // Jika waktu istirahat sudah lewat secara alami, reset pembatalan untuk hari berikutnya
    if (!inScheduleWindow && this.isScheduleAborted) {
      this.isScheduleAborted = false;
      this.scheduleAbortedReason = '';
      this.scheduleAbortedAt = 0;
      this.saveVirtualState();
    }

    const count = overridePositionsCount !== undefined ? overridePositionsCount : this.getUserPositionsCount();
    const hasOpenPositions = count > 0;
    const isGuarding = hasOpenPositions && (cfg.guardOpenPositions !== false);
    const isSleeping = inScheduleWindow && !isGuarding && !this.isScheduleAborted;

    const hoursLeft = Math.floor(diffMinsToResume / 60);
    const minsLeft = diffMinsToResume % 60;
    const resumeInText = inScheduleWindow
      ? (hoursLeft > 0 ? `${hoursLeft} jam ${minsLeft} menit lagi (${cfg.endTime} WIB)` : `${minsLeft} menit lagi (${cfg.endTime} WIB)`)
      : '';

    return {
      enabled: true,
      isSleeping,
      startTime: cfg.startTime || '10:00',
      endTime: cfg.endTime || '18:30',
      action: cfg.action || 'FULL_STOP',
      resumeInText,
      guardingPositions: inScheduleWindow && isGuarding,
      isScheduleAborted: this.isScheduleAborted,
      abortedReason: this.scheduleAbortedReason,
      abortedAt: this.scheduleAbortedAt,
    };
  }

  getCurrentPollingInfo(): PollingStatusInfo {
    const times = this.getTimes();
    const weekendStatus = this.getWeekendBreakStatus();

    // 0. Prioritas Utama: Jika terdapat antrean Auto-Sniper yang sedang mengintai pullback harga,
    // jangan gunakan standby lambat (60s). Selalu polling cepat (1-1.5s) agar momentum pullback diskon tidak hilang!
    if (this.slippageSkippedOrders.size > 0) {
      return {
        isAdaptive: false,
        currentIntervalMs: this.config.pollingIntervalMs || 1500,
        sessionName: `🎯 Auto-Sniper Pullback Hunt (${this.slippageSkippedOrders.size} order)`,
        sessionKey: 'weekend_break',
        wibTimeStr: times.wibTimeStr,
        cstTimeStr: times.cstTimeStr,
        isWeekendHoliday: weekendStatus.isHolidayActive,
      };
    }

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

    // 2. Jika Mode Libur Akhir Pekan aktif (akhir pekan WIB & tidak ada posisi terbuka & luar re-entry window)
    if (weekendStatus.isHolidayActive) {
      const standbySec = this.config.weekendBreak?.standbyIntervalSec || 60;
      return {
        isAdaptive: false,
        currentIntervalMs: standbySec * 1000,
        sessionName: '🌴 Libur Akhir Pekan (Standby WIB)',
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
    if (weekendStatus.isWeekendWIB && weekendStatus.hasOpenPositions) {
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
      : (this.lastUserPositions || []);
    const count = this.config.paperTrading ? this.virtualPositions.size : (this.lastUserPositions?.length ?? this.lastUserPositionsCount);
    const weekendBreakStatus = this.getWeekendBreakStatus(count);

    // Bersihkan order terlewati yang sudah lewat dari batas toleransi reorder (dengan margin 2x)
    const now = Date.now();
    const cleanupWindowMs = Math.max(60, (this.config.reorderWindowMinutes || 30) * 2) * 60 * 1000;
    for (const [key, item] of this.slippageSkippedOrders.entries()) {
      if (now - item.skippedAt > cleanupWindowMs) {
        this.slippageSkippedOrders.delete(key);
      }
    }

    return {
      isActive: this.isRunning,
      portfolioId: this.config.portfolioId,
      lastPollTime: this.pollCount > 0 ? new Date().toLocaleTimeString('id-ID') : null,
      pollCount: this.pollCount,
      leaderEquity: this.lastLeaderEquity,
      userEquity: this.config.paperTrading ? this.virtualWalletBalance : (this.lastUserBalance?.totalWalletBalance ?? this.lastUserBalance?.availableBalance ?? 0),
      leaderPositionsCount: this.lastLeaderPositions.size,
      userPositionsCount: userPositions.length,
      activePairs: Array.from(this.lastLeaderPositions.keys()),
      lastError: this.lastError,
      pollingInfo: this.getCurrentPollingInfo(),
      weekendBreak: weekendBreakStatus,
      dailySchedule: this.getDailyScheduleStatus(count),
      slippageSkippedOrders: Array.from(this.slippageSkippedOrders.values()),
    };
  }

  start(isAutoResume: boolean = false) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.config.copyTradeActive = true;
    this.saveConfig({ copyTradeActive: true });

    if (!isAutoResume) {
      this.isFirstTick = true;
      this.lastProcessedOrderTime = 0;
      this.processedOrderKeys.clear();
    } else {
      // Auto-resume pasca restart server: pertahankan baseline & processedOrderKeys yang dipulihkan dari DB
      this.isFirstTick = this.lastProcessedOrderTime === 0;
    }

    const modeTag = this.config.paperTrading ? '🧪 [MODE SIMULASI / PAPER TRADE]' : '🟢 [LIVE TRADING]';
    const pollInfo = this.getCurrentPollingInfo();
    const pollDesc = pollInfo.isAdaptive
      ? `⚡ Polling Adaptif Cerdas WIB: Sesi ${pollInfo.sessionName} @ ${(pollInfo.currentIntervalMs / 1000).toFixed(1)}s (${pollInfo.wibTimeStr})`
      : `⏱️ Polling Manual Tetap: ${(pollInfo.currentIntervalMs / 1000).toFixed(1)}s`;

    if (isAutoResume) {
      this.log('SUCCESS', `🔄 [AUTO-RESUME] Server restart terdeteksi dengan status AKTIF! Engine otomatis melanjutkan copy trade (${modeTag}) | ${pollDesc} untuk Leader: ${this.config.portfolioId}`);
    } else {
      this.log('SUCCESS', `🚀 Copy Trade Engine DIAKTIFKAN (${modeTag}) | ${pollDesc} untuk Leader: ${this.config.portfolioId}`);
    }
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

  /**
   * Menghentikan loop polling sementara secara aman saat server shutdown/restart
   * tanpa menonaktifkan status copyTradeActive agar auto-resume tetap bekerja
   */
  shutdown() {
    this.isRunning = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    this.saveVirtualState();
    this.log('INFO', '🛑 Copy Trade Engine dihentikan sementara secara aman untuk server shutdown.');
  }

  private async runLoop() {
    if (!this.isRunning) return;

    const scheduleStatus = this.getDailyScheduleStatus();
    const cfgSchedule = this.config.dailySchedule;

    if (scheduleStatus.enabled && scheduleStatus.isSleeping) {
      if (!this.isScheduleSleeping) {
        this.isScheduleSleeping = true;
        this.log('INFO', `💤 [JADWAL ISTIRAHAT AKTIF] Bot memasuki jam istirahat (${scheduleStatus.startTime} - ${scheduleStatus.endTime} WIB). Polling dihentikan untuk menghemat kuota proxy 100%. Akan otomatis aktif kembali ${scheduleStatus.resumeInText}.`);
        this.sendTelegramRateLimited('SCHEDULE_SLEEP', `💤 <b>[JADWAL ISTIRAHAT AKTIF]</b>\n\nSesuai jadwal Anda (<b>${scheduleStatus.startTime} - ${scheduleStatus.endTime} WIB</b>), bot memasuki mode istirahat hemat kuota 100%.\n\nOtomatis aktif kembali: <b>${scheduleStatus.resumeInText}</b>.`);
      }

      // Broadcast update ke UI dashboard agar indikator istirahat segera terlihat
      if (this.wsBroadcaster) {
        const acct = this.getLastUserAccount();
        this.wsBroadcaster('TICK', {
          status: this.getStatus(),
          leader: this.getLastLeaderDetail(),
          user: {
            balance: acct.balance,
            positions: acct.positions,
            closedTrades: this.closedTrades,
          },
        });
      }

      if (scheduleStatus.action === 'FULL_STOP') {
        // Mode FULL_STOP: Polling berhenti total (0 request / 0 kuota proxy)
        // Timer lokal memeriksa setiap 5 detik secara gratis tanpa network request
        if (this.isRunning) {
          this.pollTimeout = setTimeout(() => this.runLoop(), 5000);
        }
        return;
      }
    } else {
      if (this.isScheduleSleeping) {
        this.isScheduleSleeping = false;
        this.log('SUCCESS', `🌅 [JADWAL ISTIRAHAT SELESAI] Waktu istirahat telah berakhir (${cfgSchedule?.endTime} WIB). Engine otomatis KEMBALI AKTIF PENUH memantau transaksi leader!`);
        this.sendTelegram(`🌅 <b>[JADWAL ISTIRAHAT SELESAI]</b>\n\nWaktu istirahat terjadwal (${cfgSchedule?.startTime} - ${cfgSchedule?.endTime} WIB) telah selesai. Bot copy trade telah otomatis <b>KEMBALI AKTIF PENUH</b> memantau transaksi leader!`);
      }
    }

    try {
      await this.executeTick();
      this.lastError = null;
    } catch (err: any) {
      this.lastError = err.message;
      this.log('ERROR', `Error pada loop copy-trade: ${err.message}`);
    }

    // Interval acak (jitter ~15%) untuk menghindari ritme kaku dan deteksi bot
    const pollInfo = this.getCurrentPollingInfo();
    let baseInterval = pollInfo.currentIntervalMs;
    if (scheduleStatus.enabled && scheduleStatus.isSleeping && scheduleStatus.action === 'STANDBY') {
      baseInterval = 60000; // Mode STANDBY lambat (60s) saat jam istirahat
    }
    const jitter = (pollInfo.isWeekendHoliday || (scheduleStatus.enabled && scheduleStatus.isSleeping))
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
        this.setLastUserAccount(bal, userPositions);
      } catch (e: any) {
        this.log('WARN', `Gagal ambil saldo/posisi akun pengguna: ${e.message}`);
        userBalanceInfo = this.lastUserBalance || {
          totalWalletBalance: 0,
          totalUnrealizedProfit: 0,
          totalMarginBalance: 0,
          availableBalance: 0,
        };
        userPositions = this.lastUserPositions || [];
        userBalance = userBalanceInfo.totalWalletBalance > 0 ? userBalanceInfo.totalWalletBalance : userBalanceInfo.availableBalance;
      }
    } else {
      userBalanceInfo = this.lastUserBalance || {
        totalWalletBalance: 0,
        totalUnrealizedProfit: 0,
        totalMarginBalance: 0,
        availableBalance: 0,
      };
      userPositions = this.lastUserPositions || [];
    }

    const userPositionsMap = new Map<string, UserPosition>();
    for (const up of userPositions) {
      const key = `${up.symbol}_${up.positionSide}`;
      userPositionsMap.set(key, up);
    }
    this.lastUserPositionsCount = userPositions.length;

    // Evaluasi status Mode Libur Akhir Pekan (Waktu WIB UTC+7)
    const weekendStatus = this.getWeekendBreakStatus(userPositions.length);
    if (this.config.weekendBreak?.enabled) {
      if (weekendStatus.isHolidayActive) {
        if (!this.isHolidayActive) {
          this.isHolidayActive = true;
          this.log('INFO', `🌴 [LIBUR AKHIR PEKAN] Seluruh posisi bersih (0 posisi terbuka). Bot memasuki Mode Libur Akhir Pekan (Waktu WIB: ${weekendStatus.wibTimeStr}). Polling dialihkan ke mode standby (${this.config.weekendBreak.standbyIntervalSec || 60}s) hingga ${weekendStatus.resumeTimeStr}.`);
          this.sendTelegramRateLimited('WEEKEND_ENTER', `🌴 <b>[MODE LIBUR AKHIR PEKAN AKTIF]</b>\n\nSeluruh posisi akun Anda bersih (0 posisi terbuka).\nSesuai jadwal Waktu Indonesia Barat (WIB, UTC+7), bot beristirahat hemat kuota hingga <b>${weekendStatus.resumeTimeStr}</b>.`);
        }
      } else if (!weekendStatus.isWeekendWIB) {
        if (this.isHolidayActive) {
          this.isHolidayActive = false;
          this.log('SUCCESS', `🌅 [PASAR BUKA] Akhir pekan telah berakhir (Waktu WIB: ${weekendStatus.wibTimeStr}). Mode Libur Akhir Pekan selesai! Copy trade kembali aktif normal.`);
          this.sendTelegramRateLimited('WEEKEND_EXIT', `🌅 <b>[COPY TRADE KEMBALI AKTIF]</b>\n\nAkhir pekan telah berakhir (Waktu WIB). Bot copy trade telah kembali aktif penuh memantau transaksi leader.`);
        }
        if (this.isHolidayAborted) {
          this.isHolidayAborted = false;
          this.holidayAbortedReason = '';
          this.holidayAbortedAt = 0;
          this.saveVirtualState();
        }
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
        if (this.lastProcessedOrderTime === 0 || this.processedOrderKeys.size === 0) {
          // Cold Start baseline: tandai seluruh order saat ini sebagai baseline agar tidak tereksekusi dobel
          for (const ord of orders) {
            if (ord.orderKey) this.processedOrderKeys.add(ord.orderKey);
          }
          const maxOrderTime = Math.max(...orders.map((o) => o.orderTime));
          this.lastProcessedOrderTime = Math.max(maxOrderTime, Date.now() - 30000);
          this.saveVirtualState();
          this.log('INFO', `🔒 Mode Private Positions Aktif pada Leader. Baseline Latest Records diset pada timestamp: ${new Date(this.lastProcessedOrderTime).toLocaleTimeString('id-ID')} (${this.processedOrderKeys.size} order awal dicatat). Bot siap mengeksekusi order baru begitu Leader bertransaksi!`);
        } else {
          // Filter order yang benar-benar baru:
          // 1. Signature unik belum pernah dieksekusi (!this.processedOrderKeys.has(ord.orderKey))
          // 2. Waktu eksekusi order (orderTime / orderUpdateTime) >= baseline (dengan toleransi skew 5 detik)
          const newOrders = orders
            .filter((o) => {
              const notProcessed = o.orderKey ? !this.processedOrderKeys.has(o.orderKey) : true;
              const isRecent = o.orderTime >= (this.lastProcessedOrderTime - 5000);
              return notProcessed && isRecent;
            })
            .sort((a, b) => a.orderTime - b.orderTime); // urutkan kronologis dari lama ke baru

          // AUTO-ABORT LIBUR AKHIR PEKAN JIKA ADA TRANSAKSI BARU DARI LEADER
          if (newOrders.length > 0 && this.config.weekendBreak?.enabled && this.config.weekendBreak?.autoAbortOnLeaderTrade !== false && (this.isHolidayActive || weekendStatus.isHolidayActive || (weekendStatus.isWeekendWIB && !this.isHolidayAborted))) {
            const firstOrd = newOrders[0];
            const orderDesc = `${firstOrd.action} ${firstOrd.symbol} (${firstOrd.positionSide}) @ $${firstOrd.avgPrice || 0}`;
            this.abortWeekendHoliday(`Order baru: ${orderDesc}`, `${newOrders.length} transaksi baru terdeteksi pada feed stream leader`);
          }

          // AUTO-ABORT JADWAL ISTIRAHAT HARIAN JIKA ADA TRANSAKSI BARU DARI LEADER
          const dailyScheduleStatus = this.getDailyScheduleStatus();
          if (newOrders.length > 0 && this.config.dailySchedule?.enabled && this.config.dailySchedule?.autoAbortOnLeaderTrade !== false && (dailyScheduleStatus.isSleeping || (this.isScheduleSleeping && !this.isScheduleAborted))) {
            const firstOrd = newOrders[0];
            const orderDesc = `${firstOrd.action} ${firstOrd.symbol} (${firstOrd.positionSide}) @ $${firstOrd.avgPrice || 0}`;
            this.abortDailySchedule(`Order baru: ${orderDesc}`, `${newOrders.length} transaksi baru terdeteksi pada feed stream leader`);
          }

          for (const ord of newOrders) {
            if (ord.orderKey) {
              this.processedOrderKeys.add(ord.orderKey);
              if (this.processedOrderKeys.size > 1000) {
                const oldestKey = this.processedOrderKeys.values().next().value;
                if (oldestKey) this.processedOrderKeys.delete(oldestKey);
              }
            }
            this.lastProcessedOrderTime = Math.max(this.lastProcessedOrderTime, ord.orderTime);

            if (ord.action === 'OPEN') {
              this.log('INFO', `🔥 [Latest Records] Leader MEMBUKA ${ord.positionSide} ${ord.symbol} @ $${ord.avgPrice} (Vol: ${ord.executedQty})`);
              const posKey = `${ord.symbol}_${ord.positionSide}`;
              const existingStream = this.streamLeaderPositions.get(posKey);
              const { userPos, isReversed } = this.getUserPositionForLeader(ord.symbol, ord.positionSide, userPositionsMap);
              const hasActiveUserPos = Boolean(userPos && Math.abs(userPos.positionAmt) > 0);

              const prevTotalLeaderQty = existingStream?.amount || 0;

              let livePrice = ord.avgPrice;
              try {
                const fetchedPrice = await binanceClient.getSymbolPrice(ord.symbol);
                if (fetchedPrice > 0) livePrice = fetchedPrice;
              } catch {}

              if (existingStream) {
                const oldQty = existingStream.amount;
                const newQty = oldQty + ord.executedQty;
                const newEntry = (oldQty * existingStream.entryPrice + ord.executedQty * ord.avgPrice) / newQty;
                existingStream.amount = newQty;
                existingStream.entryPrice = newEntry;
                existingStream.notional = newQty * livePrice;
                existingStream.updateTime = ord.orderTime;
              } else {
                if (!this.positionAvgCounts.has(posKey)) {
                  this.positionAvgCounts.set(posKey, { leader: 0, user: 0 });
                }
                this.streamLeaderPositions.set(posKey, {
                  symbol: ord.symbol,
                  positionSide: ord.positionSide,
                  amount: ord.executedQty,
                  entryPrice: ord.avgPrice,
                  markPrice: livePrice,
                  leverage: userPos?.leverage || 10,
                  marginType: 'CROSSED',
                  unrealizedProfit: 0,
                  notional: ord.executedQty * livePrice,
                  updateTime: ord.orderTime,
                  avgCount: 0,
                });
              }
              this.saveVirtualState();

              const lev = userPos?.leverage || existingStream?.leverage || 10;
              const mockPos: LeadPosition = {
                symbol: ord.symbol,
                positionSide: ord.positionSide,
                amount: ord.executedQty,
                entryPrice: ord.avgPrice,
                markPrice: livePrice,
                leverage: lev,
                marginType: 'CROSSED',
                unrealizedProfit: 0,
                notional: ord.executedQty * livePrice,
                avgCount: this.positionAvgCounts.get(posKey)?.leader || 0,
              };

              if (hasActiveUserPos && userPos) {
                // Posisi akun user sudah aktif -> Eksekusi Averaging Down (Scale In)!
                const prevQty = prevTotalLeaderQty > 0 ? prevTotalLeaderQty : ord.executedQty;
                this.log('INFO', `📈 [Latest Records] Leader menambah muatan (Averaging Down): ${ord.symbol} ${ord.positionSide} (+${ord.executedQty} @ $${ord.avgPrice})`);
                const avgRes = await this.handleAveraging(mockPos, ord.executedQty, prevQty, userBalance, userPos);
                if (avgRes && userPos) {
                  const actualKey = `${userPos.symbol}_${userPos.positionSide}`;
                  userPositionsMap.set(actualKey, userPos);
                  const uIdx = userPositions.findIndex((u) => `${u.symbol}_${u.positionSide}` === actualKey);
                  if (uIdx !== -1) userPositions[uIdx] = { ...userPos };
                }
                const counts = this.positionAvgCounts.get(posKey);
                const updatedStream = this.streamLeaderPositions.get(posKey);
                if (updatedStream && counts) {
                  updatedStream.avgCount = counts.leader;
                }
              } else {
                // User belum memiliki posisi terbuka pada simbol & arah ini -> Buka posisi baru
                if (existingStream) {
                  const counts = this.positionAvgCounts.get(posKey) || { leader: 0, user: 0 };
                  counts.leader = (counts.leader || 0) + 1;
                  this.positionAvgCounts.set(posKey, counts);
                  existingStream.avgCount = counts.leader;
                }
                const newPos = await this.handleNewPosition(mockPos, userBalance, undefined);
                if (newPos) {
                  const actualKey = `${newPos.symbol}_${newPos.positionSide}`;
                  userPositionsMap.set(actualKey, newPos);
                  const uIdx = userPositions.findIndex((u) => `${u.symbol}_${u.positionSide}` === actualKey);
                  if (uIdx !== -1) userPositions[uIdx] = newPos;
                  else userPositions.push(newPos);
                }
              }
            } else if (ord.action === 'CLOSE') {
              const { userPos } = this.getUserPositionForLeader(ord.symbol, ord.positionSide, userPositionsMap);
              if (userPos && Math.abs(userPos.positionAmt) > 0) {
                const leaderStreamKey = `${ord.symbol}_${ord.positionSide}`;
                const userPosKey = `${userPos.symbol}_${userPos.positionSide}`;
                const userCurrentQty = Math.abs(userPos.positionAmt);
                const filter = await binanceClient.getSymbolFilter(ord.symbol);

                // Cek rasio penutupan koin oleh Leader di stream
                const existingStream = this.streamLeaderPositions.get(leaderStreamKey);
                const leaderTotalQty = existingStream?.amount || ord.executedQty;
                const leaderCloseRatio = leaderTotalQty > 0 ? (ord.executedQty / leaderTotalQty) : 1;

                // Hitung kuantitas tutup proporsional terhadap volume posisi user saat ini
                let targetCloseQty = binanceClient.roundQuantity(userCurrentQty * leaderCloseRatio, filter.stepSize);

                // Harga mark/eksekusi untuk valuasi nilai notional ($5 USDT rule Binance Futures)
                const evalPrice = ord.avgPrice > 0 ? ord.avgPrice : (userPos.markPrice || userPos.entryPrice || 1);
                const minCloseQty = binanceClient.roundQuantity(Math.ceil((filter.minNotional * 1.05) / evalPrice / filter.stepSize) * filter.stepSize, filter.stepSize);

                const remainingQty = Math.max(0, userCurrentQty - targetCloseQty);
                const remainingNotional = remainingQty * evalPrice;
                const closeNotional = targetCloseQty * evalPrice;

                // POIN 2: Jika Leader menutup >= 90% dari posisinya, pasti FULL CLOSE!
                const isLeaderFullClose = leaderCloseRatio >= 0.90 || ord.executedQty >= leaderTotalQty;

                // POIN 1: Proteksi Dust / Koin Receh (< $5 USDT rule Binance Futures)
                const isDustRemaining = remainingNotional < filter.minNotional || remainingQty < filter.minQty;
                const isCloseTooSmall = closeNotional < filter.minNotional;

                let isFullClose = isLeaderFullClose || isDustRemaining || targetCloseQty >= userCurrentQty || (userCurrentQty - targetCloseQty) < filter.minQty;

                if (!isFullClose && isCloseTooSmall) {
                  if ((userCurrentQty - minCloseQty) * evalPrice < filter.minNotional || userCurrentQty <= minCloseQty) {
                    isFullClose = true;
                  } else {
                    targetCloseQty = minCloseQty;
                  }
                }

                const actualCloseQty = isFullClose ? binanceClient.roundQuantity(userCurrentQty, filter.stepSize) : targetCloseQty;

                // Jika partial close di bawah batas minimal lot dan bukan full close, lewati
                if (!isFullClose && actualCloseQty < filter.minQty) {
                  this.log('INFO', `🎯 [Latest Records] Partial close ${ord.symbol} (${userPos.positionSide}) dilewati karena kuantitas (${actualCloseQty}) di bawah batas minimum Binance (${filter.minQty}).`);
                  continue;
                }
                const pnl = userPos.positionSide === 'LONG'
                  ? (ord.avgPrice - userPos.entryPrice) * actualCloseQty
                  : (userPos.entryPrice - ord.avgPrice) * actualCloseQty;
                const pnlPct = userPos.entryPrice > 0
                  ? ((ord.avgPrice - userPos.entryPrice) / userPos.entryPrice) * (userPos.positionSide === 'LONG' ? 1 : -1) * 100 * (userPos.leverage || 10)
                  : 0;

                if (isFullClose) {
                  this.log('INFO', `🎯 [Latest Records] Leader MENUTUP ${ord.positionSide} ${ord.symbol} @ $${ord.avgPrice}. Menutup posisi akun Anda (${userPos.positionSide})...`);
                  let closeSucceeded = false;
                  if (this.config.paperTrading) {
                    this.virtualWalletBalance += pnl;
                    this.virtualPositions.delete(userPosKey);
                    this.streamLeaderPositions.delete(leaderStreamKey);
                    this.positionAvgCounts.delete(leaderStreamKey);
                    this.saveVirtualState();
                    this.log('SUCCESS', `🧪 [MODE SIMULASI] Posisi ${ord.symbol} (${userPos.positionSide}) ditutup penuh sinkron! PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDT (Saldo virtual: $${this.virtualWalletBalance.toFixed(2)} USDT)`);
                    closeSucceeded = true;
                  } else {
                    try {
                      const closeSide: 'LONG' | 'SHORT' = userPos.positionSide === 'SHORT' || userPos.positionAmt < 0 ? 'SHORT' : 'LONG';
                      await binanceClient.closePosition(ord.symbol, closeSide, actualCloseQty);
                      this.streamLeaderPositions.delete(leaderStreamKey);
                      this.positionAvgCounts.delete(leaderStreamKey);
                      this.saveVirtualState();
                      this.log('SUCCESS', `✅ Posisi ${ord.symbol} (${userPos.positionSide}) akun Anda berhasil ditutup penuh.`);
                      closeSucceeded = true;
                    } catch (e: any) {
                      const errMsg = e.response?.data?.msg || e.message;
                      this.log('ERROR', `❌ Gagal menutup penuh ${ord.symbol}: ${errMsg}`);
                      this.sendTelegram(
                        `🚨 <b>CRITICAL: GAGAL MENUTUP POSISI [🟢 LIVE FUTURES]</b>\n\n` +
                        `🪙 Simbol: <b>${ord.symbol}</b> (${userPos.positionSide})\n` +
                        `❌ Error: <code>${errMsg}</code>\n` +
                        `⚠️ Leader sudah menutup posisi ini! Harap segera periksa dan tutup manual di Binance jika masih terbuka.`
                      );
                    }
                  }

                  if (closeSucceeded) {
                    userPositionsMap.delete(userPosKey);
                    const uIdx = userPositions.findIndex((u) => `${u.symbol}_${u.positionSide}` === userPosKey);
                    if (uIdx !== -1) userPositions.splice(uIdx, 1);
                    this.recordClosedTrade({
                      symbol: ord.symbol,
                      positionSide: userPos.positionSide as any,
                      action: 'FULL_CLOSE',
                      qty: actualCloseQty,
                      entryPrice: userPos.entryPrice,
                      closePrice: ord.avgPrice,
                      realizedPnl: Number(pnl.toFixed(2)),
                      pnlPct: Number(pnlPct.toFixed(2)),
                      isPaper: this.config.paperTrading,
                    });
                  }
                } else {
                  const existingStream = this.streamLeaderPositions.get(leaderStreamKey);
                  if (existingStream) {
                    existingStream.amount = Math.max(0, existingStream.amount - ord.executedQty);
                    if (existingStream.amount === 0) {
                      this.streamLeaderPositions.delete(leaderStreamKey);
                    }
                    this.saveVirtualState();
                  }
                  this.log('INFO', `🎯 [Latest Records] Leader PARTIAL CLOSE ${ord.positionSide} ${ord.symbol} @ $${ord.avgPrice}. Menutup sebagian posisi akun Anda (${userPos.positionSide}, -${actualCloseQty})`);
                  let partialCloseSucceeded = false;
                  if (this.config.paperTrading) {
                    const remainingQty = userCurrentQty - actualCloseQty;
                    this.virtualWalletBalance += pnl;
                    userPos.positionAmt = userPos.positionSide === 'LONG' ? remainingQty : -remainingQty;
                    userPos.notional = remainingQty * ord.avgPrice;
                    userPos.margin = (remainingQty * (userPos.entryPrice || ord.avgPrice)) / Math.max(1, userPos.leverage || 10);
                    this.virtualPositions.set(userPosKey, userPos);
                    this.saveVirtualState();
                    this.log('SUCCESS', `🧪 [MODE SIMULASI] Partial close ${ord.symbol} (${userPos.positionSide}) selesai (-${actualCloseQty}). PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDT (Sisa: ${remainingQty.toFixed(4)} koin)`);
                    partialCloseSucceeded = true;
                  } else {
                    try {
                      const closeSide: 'LONG' | 'SHORT' = userPos.positionSide === 'SHORT' || userPos.positionAmt < 0 ? 'SHORT' : 'LONG';
                      await binanceClient.closePosition(ord.symbol, closeSide, actualCloseQty);
                      this.log('SUCCESS', `✅ Partial close ${ord.symbol} (${userPos.positionSide}, -${actualCloseQty}) berhasil dieksekusi.`);
                      partialCloseSucceeded = true;
                    } catch (e: any) {
                      const errMsg = e.response?.data?.msg || e.message;
                      this.log('ERROR', `❌ Gagal partial close ${ord.symbol}: ${errMsg}`);
                      this.sendTelegram(
                        `⚠️ <b>GAGAL MENUTUP PARSIAL [🟢 LIVE FUTURES]</b>\n\n` +
                        `🪙 Simbol: <b>${ord.symbol}</b> (${userPos.positionSide})\n` +
                        `❌ Error: <code>${errMsg}</code>`
                      );
                    }
                  }

                  if (partialCloseSucceeded) {
                    const remainingQty = Math.max(0, userCurrentQty - actualCloseQty);
                    userPos.positionAmt = userPos.positionSide === 'LONG' ? remainingQty : -remainingQty;
                    userPos.notional = remainingQty * (ord.avgPrice || userPos.entryPrice || 0);
                    userPos.margin = (remainingQty * (userPos.entryPrice || ord.avgPrice || 0)) / Math.max(1, userPos.leverage || 10);
                    userPositionsMap.set(userPosKey, userPos);
                    const uIdx = userPositions.findIndex((u) => `${u.symbol}_${u.positionSide}` === userPosKey);
                    if (uIdx !== -1) userPositions[uIdx] = { ...userPos };
                    this.recordClosedTrade({
                      symbol: ord.symbol,
                      positionSide: userPos.positionSide as any,
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
      }

      // Sinkronisasi posisi leader aktif dari order stream dengan posisi akun user
      for (const up of userPositions) {
        const key = `${up.symbol}_${up.positionSide}`;
        if (!this.streamLeaderPositions.has(key)) {
          const matchingOpens = orders.filter(
            (o) => o.symbol === up.symbol && o.positionSide === up.positionSide && o.action === 'OPEN' && o.avgPrice > 0
          );
          if (matchingOpens.length > 0) {
            let totalQty = 0;
            let totalNotional = 0;
            let latestTime = 0;
            for (const mo of matchingOpens) {
              totalQty += mo.executedQty;
              totalNotional += mo.executedQty * mo.avgPrice;
              latestTime = Math.max(latestTime, mo.orderTime);
            }
            const avgEntry = totalQty > 0 ? totalNotional / totalQty : matchingOpens[0].avgPrice;
            const counts = this.positionAvgCounts.get(key);
            const leaderAvg = counts?.leader || Math.max(0, matchingOpens.length - 1);

            this.streamLeaderPositions.set(key, {
              symbol: matchingOpens[0].symbol,
              positionSide: matchingOpens[0].positionSide,
              amount: totalQty,
              entryPrice: avgEntry,
              markPrice: up.markPrice || avgEntry,
              leverage: up.leverage || 10,
              marginType: 'CROSSED',
              unrealizedProfit: 0,
              notional: totalQty * (up.markPrice || avgEntry),
              updateTime: latestTime || Date.now(),
              avgCount: leaderAvg,
            });
          }
        }
      }

      // Bersihkan posisi stream jika akun user sudah tidak memiliki posisi pada koin tersebut
      // (Kecuali posisi yang baru dibuat/diperbarui kurang dari 60 detik agar tidak terkena race condition)
      for (const [key, slp] of this.streamLeaderPositions.entries()) {
        const isFresh = slp.updateTime && (Date.now() - slp.updateTime < 60000);
        if (!userPositionsMap.has(key) && !isFresh) {
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
        if (currentLeaderMap.size > 0 && weekendStatus.isWeekendWIB && this.config.weekendBreak?.enabled && this.config.weekendBreak?.autoAbortOnLeaderTrade !== false) {
          const syms = Array.from(currentLeaderMap.keys()).join(', ');
          this.abortWeekendHoliday(`Leader memiliki posisi aktif (${syms})`, `Deteksi baseline posisi aktif leader di akhir pekan`);
        }
      } else {
        for (const [key, leaderPos] of currentLeaderMap.entries()) {
          const prevLeaderPos = this.lastLeaderPositions.get(key);

          if (!prevLeaderPos) {
            // POSISI BARU DIBUKA OLEH LEADER
            this.log('INFO', `🔥 DETEKSI POSISI BARU: Leader membuka ${leaderPos.positionSide} ${leaderPos.symbol} @ $${leaderPos.entryPrice} (Vol: ${leaderPos.amount})`);
            if (this.config.weekendBreak?.enabled && this.config.weekendBreak?.autoAbortOnLeaderTrade !== false && (this.isHolidayActive || weekendStatus.isHolidayActive || (weekendStatus.isWeekendWIB && !this.isHolidayAborted))) {
              this.abortWeekendHoliday(`Buka posisi ${leaderPos.symbol} (${leaderPos.positionSide})`, `Entry: $${leaderPos.entryPrice}, Vol: ${leaderPos.amount}`);
            }
            const dailyScheduleStatus = this.getDailyScheduleStatus();
            if (this.config.dailySchedule?.enabled && this.config.dailySchedule?.autoAbortOnLeaderTrade !== false && (dailyScheduleStatus.isSleeping || (this.isScheduleSleeping && !this.isScheduleAborted))) {
              this.abortDailySchedule(`Buka posisi ${leaderPos.symbol} (${leaderPos.positionSide})`, `Entry: $${leaderPos.entryPrice}, Vol: ${leaderPos.amount}`);
            }
            const { userPos } = this.getUserPositionForLeader(leaderPos.symbol, leaderPos.positionSide, userPositionsMap);
            const newPos = await this.handleNewPosition(leaderPos, userBalance, userPos);
            if (newPos) {
              const actualKey = `${newPos.symbol}_${newPos.positionSide}`;
              userPositionsMap.set(actualKey, newPos);
              const uIdx = userPositions.findIndex((u) => `${u.symbol}_${u.positionSide}` === actualKey);
              if (uIdx !== -1) userPositions[uIdx] = newPos;
              else userPositions.push(newPos);
            }
          } else {
            // POSISI SUDAH ADA SEBELUMNYA: Cek apakah leader menambah posisi (Averaging) atau partial close
            const deltaAmount = leaderPos.amount - prevLeaderPos.amount;
            const deltaPct = prevLeaderPos.amount > 0 ? deltaAmount / prevLeaderPos.amount : 0;

            if (deltaAmount > 0 && deltaPct >= 0.02) {
              // Leader Menambah Posisi (Averaging Down / Scaling In)
              this.log('INFO', `📈 LEADER MENAMBAH POSISI: ${leaderPos.symbol} ${leaderPos.positionSide} (+${deltaAmount.toFixed(4)} koin, +${(deltaPct * 100).toFixed(1)}%)`);
              if (this.config.weekendBreak?.enabled && this.config.weekendBreak?.autoAbortOnLeaderTrade !== false && (this.isHolidayActive || weekendStatus.isHolidayActive || (weekendStatus.isWeekendWIB && !this.isHolidayAborted))) {
                this.abortWeekendHoliday(`Tambah posisi ${leaderPos.symbol} (${leaderPos.positionSide})`, `+${deltaAmount.toFixed(4)} koin (+${(deltaPct * 100).toFixed(1)}%)`);
              }
              const dailyScheduleStatus = this.getDailyScheduleStatus();
              if (this.config.dailySchedule?.enabled && this.config.dailySchedule?.autoAbortOnLeaderTrade !== false && (dailyScheduleStatus.isSleeping || (this.isScheduleSleeping && !this.isScheduleAborted))) {
                this.abortDailySchedule(`Tambah posisi ${leaderPos.symbol} (${leaderPos.positionSide})`, `+${deltaAmount.toFixed(4)} koin (+${(deltaPct * 100).toFixed(1)}%)`);
              }
              const { userPos } = this.getUserPositionForLeader(leaderPos.symbol, leaderPos.positionSide, userPositionsMap);
              const avgRes = await this.handleAveraging(leaderPos, deltaAmount, prevLeaderPos.amount, userBalance, userPos);
              if (avgRes && userPos) {
                const actualKey = `${userPos.symbol}_${userPos.positionSide}`;
                const uPos = userPositionsMap.get(actualKey);
                if (uPos) {
                  const uIdx = userPositions.findIndex((u) => `${u.symbol}_${u.positionSide}` === actualKey);
                  if (uIdx !== -1) userPositions[uIdx] = { ...uPos };
                }
              }
            } else if (deltaAmount < 0 && Math.abs(deltaPct) >= 0.02) {
              // Leader Partial Close
              this.log('INFO', `📉 LEADER PARTIAL CLOSE: ${leaderPos.symbol} ${leaderPos.positionSide} (-${Math.abs(deltaAmount).toFixed(4)} koin)`);
              if (this.config.weekendBreak?.enabled && this.config.weekendBreak?.autoAbortOnLeaderTrade !== false && (this.isHolidayActive || weekendStatus.isHolidayActive || (weekendStatus.isWeekendWIB && !this.isHolidayAborted))) {
                this.abortWeekendHoliday(`Partial close ${leaderPos.symbol} (${leaderPos.positionSide})`, `-${Math.abs(deltaAmount).toFixed(4)} koin`);
              }
              const dailyScheduleStatus = this.getDailyScheduleStatus();
              if (this.config.dailySchedule?.enabled && this.config.dailySchedule?.autoAbortOnLeaderTrade !== false && (dailyScheduleStatus.isSleeping || (this.isScheduleSleeping && !this.isScheduleAborted))) {
                this.abortDailySchedule(`Partial close ${leaderPos.symbol} (${leaderPos.positionSide})`, `-${Math.abs(deltaAmount).toFixed(4)} koin`);
              }
              const { userPos } = this.getUserPositionForLeader(leaderPos.symbol, leaderPos.positionSide, userPositionsMap);
              await this.handlePartialClose(leaderPos, Math.abs(deltaAmount), prevLeaderPos.amount, userPos);
            }
          }
        }

        // Deteksi FULL CLOSE (Posisi sebelumnya ada tapi sekarang hilang dari leader)
        for (const [key, prevLeaderPos] of this.lastLeaderPositions.entries()) {
          if (!currentLeaderMap.has(key)) {
            this.log('INFO', `🎯 LEADER MENUTUP POSISI: ${prevLeaderPos.symbol} ${prevLeaderPos.positionSide}. Menutup posisi akun pengguna...`);
            if (this.config.weekendBreak?.enabled && this.config.weekendBreak?.autoAbortOnLeaderTrade !== false && (this.isHolidayActive || weekendStatus.isHolidayActive || (weekendStatus.isWeekendWIB && !this.isHolidayAborted))) {
              this.abortWeekendHoliday(`Tutup posisi ${prevLeaderPos.symbol} (${prevLeaderPos.positionSide})`, `Leader menutup penuh posisi`);
            }
            const dailyScheduleStatus = this.getDailyScheduleStatus();
            if (this.config.dailySchedule?.enabled && this.config.dailySchedule?.autoAbortOnLeaderTrade !== false && (dailyScheduleStatus.isSleeping || (this.isScheduleSleeping && !this.isScheduleAborted))) {
              this.abortDailySchedule(`Tutup posisi ${prevLeaderPos.symbol} (${prevLeaderPos.positionSide})`, `Leader menutup penuh posisi`);
            }
            const { userPos } = this.getUserPositionForLeader(prevLeaderPos.symbol, prevLeaderPos.positionSide, userPositionsMap);
            if (userPos && Math.abs(userPos.positionAmt) > 0) {
              const closed = await this.handleFullClose(prevLeaderPos, userPos);
              if (closed) {
                const userKey = `${userPos.symbol}_${userPos.positionSide}`;
                userPositionsMap.delete(userKey);
                const uIdx = userPositions.findIndex((u) => `${u.symbol}_${u.positionSide}` === userKey);
                if (uIdx !== -1) userPositions.splice(uIdx, 1);
              }
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
            const filter = await binanceClient.getSymbolFilter(up.symbol);
            const slQty = binanceClient.roundQuantity(Math.abs(up.positionAmt), filter.stepSize);
            const slPnl = up.unRealizedProfit;

            const posKey = `${up.symbol}_${side}`;
            let slClosed = false;

            if (this.config.paperTrading) {
              this.virtualWalletBalance += slPnl;
              this.virtualPositions.delete(posKey);
              this.streamLeaderPositions.delete(posKey);
              this.positionAvgCounts.delete(posKey);
              this.saveVirtualState();
              this.log('SUCCESS', `🧪 [MODE SIMULASI] Posisi virtual ${up.symbol} ditutup via Emergency Stop Loss! PnL: -$${Math.abs(slPnl).toFixed(2)} USDT`);
              slClosed = true;
            } else {
              try {
                await binanceClient.closePosition(up.symbol, side, slQty);
                this.streamLeaderPositions.delete(posKey);
                this.positionAvgCounts.delete(posKey);
                this.saveVirtualState();
                this.log('SUCCESS', `✅ Berhasil menutup darurat ${up.symbol}`);
                slClosed = true;
              } catch (e: any) {
                this.log('ERROR', `Gagal menutup darurat ${up.symbol}: ${e.message}`);
              }
            }

            if (slClosed) {
              userPositionsMap.delete(posKey);
              const uIdx = userPositions.findIndex((u) => `${u.symbol}_${u.positionSide}` === posKey);
              if (uIdx !== -1) userPositions.splice(uIdx, 1);

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
    }

    // Update snapshot posisi & data leader
    this.lastLeaderPositions = currentLeaderMap;
    this.lastLeaderDetail = leaderDetail;

    // AUTO-SNIPER PULLBACK: Periksa antrean order tertahan yang harganya telah pullback ke level entry leader
    await this.checkAutoSniperPullback(currentLeaderMap, userBalance, userPositionsMap, userPositions);

    // Pasang avgCount dan sinkronkan live Mark Price & Floating PnL ke posisi leader sebelum broadcast
    for (const lp of currentLeaderPositions) {
      const counts = this.positionAvgCounts.get(`${lp.symbol}_${lp.positionSide}`);
      lp.avgCount = counts?.leader || 0;
      if (!lp.markPrice || lp.markPrice <= 0) {
        const up = userPositionsMap.get(`${lp.symbol}_${lp.positionSide}`);
        if (up && up.markPrice > 0) lp.markPrice = up.markPrice;
      }
      if (lp.markPrice > 0 && lp.entryPrice > 0 && lp.amount > 0) {
        lp.unrealizedProfit = lp.positionSide === 'LONG'
          ? (lp.markPrice - lp.entryPrice) * lp.amount
          : (lp.entryPrice - lp.markPrice) * lp.amount;
        lp.notional = lp.amount * lp.markPrice;
      }
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

  private async handleNewPosition(leaderPos: LeadPosition, userBalance: number, existingUserPos?: UserPosition): Promise<UserPosition | null> {
    // 0. Proteksi Mode Libur Akhir Pekan (Waktu WIB UTC+7)
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

    const dailyScheduleStatus = this.getDailyScheduleStatus();
    if (this.config.dailySchedule?.enabled && this.config.dailySchedule?.autoAbortOnLeaderTrade !== false && (dailyScheduleStatus.isSleeping || (this.isScheduleSleeping && !this.isScheduleAborted))) {
      this.abortDailySchedule(`Leader Membuka Posisi: ${leaderPos.symbol} (${leaderPos.positionSide})`, `Auto-abort dipicu di handleNewPosition`);
    }

    if (!this.isHolidayAborted && this.config.weekendBreak?.enabled && weekendStatus.isWeekendWIB && this.config.weekendBreak.blockNewTrades !== false) {
      if (this.config.weekendBreak?.autoAbortOnLeaderTrade !== false) {
        this.abortWeekendHoliday(`Leader Membuka Posisi: ${leaderPos.symbol} (${leaderPos.positionSide})`, `Auto-abort dipicu di handleNewPosition`);
      } else if (isAveragingDown) {
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
        this.log('INFO', `🌴 [LIBUR AKHIR PEKAN] Melewatkan pembukaan posisi baru ${leaderPos.symbol} ${leaderPos.positionSide} karena Mode Libur Akhir Pekan aktif (Waktu WIB: ${weekendStatus.wibTimeStr}) dan akun belum memiliki posisi terbuka pada koin ini.`);
        return null;
      }
    }

    if (!this.config.paperTrading && !binanceClient.isConfigured()) {
      this.log('WARN', 'Lewati eksekusi: API Key Binance belum dikonfigurasi di dashboard.');
      return null;
    }

    // Proteksi duplikasi order: Jika akun Anda sudah memiliki posisi terbuka pada simbol & arah ini, lewati pembukaan ganda
    if (existingUserPos && Math.abs(existingUserPos.positionAmt) > 0) {
      this.log('INFO', `ℹ️ Posisi ${leaderPos.symbol} ${existingUserPos.positionSide} sudah terbuka aktif di akun Anda. Menghubungkan tracking posisi tanpa membuka order baru.`);
      return existingUserPos;
    }

    // Cek apakah mode Reverse Trading (Fade Leader) aktif untuk posisi baru
    const isInverse = Boolean(this.config.reverseTrading && !existingUserPos);
    const userPositionSide: 'LONG' | 'SHORT' = isInverse
      ? (leaderPos.positionSide === 'LONG' ? 'SHORT' : 'LONG')
      : leaderPos.positionSide;
    const side: 'BUY' | 'SELL' = userPositionSide === 'LONG' ? 'BUY' : 'SELL';

    // Validasi Slippage Guard (Directional Asymmetric & Auto-Sniper)
    let adverseSlippagePct = 0;
    let favorableSlippagePct = 0;
    if (leaderPos.entryPrice > 0 && leaderPos.markPrice > 0) {
      if (userPositionSide === 'LONG') {
        if (leaderPos.markPrice > leaderPos.entryPrice) {
          adverseSlippagePct = ((leaderPos.markPrice - leaderPos.entryPrice) / leaderPos.entryPrice) * 100;
        } else {
          favorableSlippagePct = ((leaderPos.entryPrice - leaderPos.markPrice) / leaderPos.entryPrice) * 100;
        }
      } else {
        // SHORT
        if (leaderPos.markPrice < leaderPos.entryPrice) {
          adverseSlippagePct = ((leaderPos.entryPrice - leaderPos.markPrice) / leaderPos.entryPrice) * 100;
        } else {
          favorableSlippagePct = ((leaderPos.markPrice - leaderPos.entryPrice) / leaderPos.entryPrice) * 100;
        }
      }

      const allowedAdversePct = this.config.zeroSlippageOnly ? 0.01 : (this.config.maxSlippagePct || 0.5);

      if (adverseSlippagePct > allowedAdversePct) {
        const posKey = `${leaderPos.symbol}_${leaderPos.positionSide}`;
        this.slippageSkippedOrders.set(posKey, {
          symbol: leaderPos.symbol,
          positionSide: leaderPos.positionSide,
          type: 'NEW_POSITION',
          leaderEntryPrice: leaderPos.entryPrice,
          markPrice: leaderPos.markPrice,
          slippagePct: adverseSlippagePct,
          adverseSlippagePct,
          targetPullbackPrice: leaderPos.entryPrice,
          isSniperPending: true,
          notifiedSniper: true,
          skippedAt: Date.now(),
          reason: `Harga pasar ($${leaderPos.markPrice}) lebih buruk +${adverseSlippagePct.toFixed(2)}% dari entry leader ($${leaderPos.entryPrice}). Auto-Sniper aktif memantau pullback.`,
        });
        this.saveVirtualState();

        const windowMins = this.config.reorderWindowMinutes || 30;
        const targetOp = userPositionSide === 'LONG' ? '≤' : '≥';
        const invTag = isInverse ? ' (🔄 Inversi)' : '';
        const leaderMargin = (leaderPos.amount > 0 && (leaderPos.entryPrice > 0 || leaderPos.markPrice > 0))
          ? (leaderPos.amount * (leaderPos.entryPrice || leaderPos.markPrice)) / Math.max(1, leaderPos.leverage || 10)
          : 0;
        const sniperEstMargin = (this.config.mode === 'FIXED_AMOUNT'
          ? this.config.fixedAmountUsdt
          : (this.config.mode === 'FIXED_RATIO'
            ? userBalance * 0.05 * this.config.ratioMultiplier
            : (userBalance / (this.lastLeaderEquity || 50000)) * this.config.ratioMultiplier * leaderPos.amount * (leaderPos.entryPrice || leaderPos.markPrice)
          )) / Math.max(1, leaderPos.leverage || 10);

        this.log('WARN', `🎯 [AUTO-SNIPER AKTIF] Order ${leaderPos.symbol} (${userPositionSide}${invTag}) ditahan: Harga pasar ($${leaderPos.markPrice}) lebih buruk +${adverseSlippagePct.toFixed(2)}% dibanding entry leader ($${leaderPos.entryPrice}). Bot otomatis memantau pullback ke ${targetOp} $${leaderPos.entryPrice} selama ${windowMins} menit.`);
        this.sendTelegramRateLimited(
          `SNIPER_PENDING_${posKey}`,
          `🎯 <b>ORDER DITAHAN - AUTO-SNIPER PULLBACK AKTIF</b>\n\n` +
          `🪙 Simbol: <b>${leaderPos.symbol}</b>\n` +
          `📊 Posisi Akun: <b>${userPositionSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>${invTag}\n` +
          `👤 Entry Leader: <b>$${leaderPos.entryPrice}</b>\n` +
          `📈 Harga Pasar Saat Ini: <b>$${leaderPos.markPrice}</b>\n` +
          `⚠️ Selisih Kurang Menguntungkan: <b>+${adverseSlippagePct.toFixed(2)}%</b>\n` +
          `⚡ Leverage: <b>${leaderPos.leverage || 10}x</b>\n` +
          `💰 Estimasi Margin Order: <b>$${Math.max(5, sniperEstMargin).toFixed(2)} USDT</b>\n` +
          (leaderMargin > 0 ? `👤 Margin Leader: <b>$${leaderMargin.toFixed(2)} USDT</b>\n` : '') +
          `\n🛡️ <i>Sistem menahan order demi memastikan Slippage 0 / Diskon. Bot memantau chart setiap detik dan akan <b>OTOMATIS MASUK</b> begitu harga pullback ke <b>${targetOp} $${leaderPos.entryPrice}</b> (sisa batas toleransi ${windowMins} menit).</i>`,
          60000
        );
        return null;
      }
    }

    // Hitung kuantitas target
    const filter = await binanceClient.getSymbolFilter(leaderPos.symbol);
    const markPrice = leaderPos.markPrice > 0 ? leaderPos.markPrice : leaderPos.entryPrice;
    if (markPrice <= 0) return null;

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

    // Proteksi minQty & minNotional ($5 USDT rule Binance Futures)
    if (targetQty < filter.minQty) {
      targetQty = filter.minQty;
    }
    if (targetQty * markPrice < filter.minNotional) {
      const minQtyForNotional = binanceClient.roundQuantity(Math.ceil((filter.minNotional * 1.05) / markPrice / filter.stepSize) * filter.stepSize, filter.stepSize);
      const testMargin = (minQtyForNotional * markPrice) / lev;
      const maxAllowedMargin = this.config.maxModalPerCoin > 0
        ? this.config.maxModalPerCoin
        : (userBalance > 0 ? userBalance * 0.5 : 50);

      if (testMargin <= maxAllowedMargin) {
        targetQty = minQtyForNotional;
      } else {
        this.log('WARN', `Kuantitas order ${leaderPos.symbol} (${targetQty}) di bawah batas minimum Binance ($${filter.minNotional} USDT / ${filter.minQty}) dan menaikkannya melanggar batas margin aman ($${maxAllowedMargin.toFixed(2)} USDT). Order dibatalkan.`);
        return null;
      }
    }

    // JIKA MODE SIMULASI (PAPER TRADING) AKTIF: Eksekusi secara virtual tanpa API Key & tanpa modal riil
    if (this.config.paperTrading) {
      const posKey = `${leaderPos.symbol}_${userPositionSide}`;
      const lev = Math.max(1, leaderPos.leverage || 10);
      const estMargin = (targetQty * markPrice) / lev;
      const counts = this.positionAvgCounts.get(posKey) || { leader: 0, user: 0 };
      counts.user = 0;
      this.positionAvgCounts.set(posKey, counts);

      const virtualPos: UserPosition = {
        symbol: leaderPos.symbol,
        positionSide: userPositionSide,
        positionAmt: userPositionSide === 'LONG' ? targetQty : -targetQty,
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
      const modeTag = isInverse ? '🧪 SIMULASI - 🔄 INVERSE' : '🧪 SIMULASI';
      const discountTag = favorableSlippagePct > 0 ? ` [🔥 DISKON +${favorableSlippagePct.toFixed(2)}% LEBIH MURAH!]` : '';
      const leaderMargin = (leaderPos.amount > 0 && (leaderPos.entryPrice > 0 || markPrice > 0)) ? (leaderPos.amount * (leaderPos.entryPrice || markPrice)) / Math.max(1, leaderPos.leverage || 10) : 0;
      this.log('SUCCESS', `[${modeTag}] Order virtual BERHASIL DIBUKA: ${side} ${targetQty} ${leaderPos.symbol} (${userPositionSide}) @ $${markPrice}${discountTag} (Estimasi Margin: $${estMargin.toFixed(2)} USDT, Leverage: ${lev}x)`);
      this.sendTelegram(
        `🚀 <b>ORDER COPY TRADE DIBUKA [${modeTag}]</b>\n\n` +
        `🪙 Simbol: <b>${leaderPos.symbol}</b>\n` +
        `📊 Posisi Akun: <b>${userPositionSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>${isInverse ? ' <i>(🔄 Inversi Fade Leader)</i>' : ''}\n` +
        `👤 Arah Leader: <b>${leaderPos.positionSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
        (leaderPos.entryPrice > 0 ? `🎯 Entry Leader: <b>$${leaderPos.entryPrice}</b>\n` : '') +
        `💵 Entry Anda: <b>$${markPrice}</b>\n` +
        `📍 Harga Mark: <b>$${markPrice}</b>\n` +
        (favorableSlippagePct > 0 ? `🔥 Slippage Plus: <b>Diskon +${favorableSlippagePct.toFixed(2)}% Lebih Murah dari Leader!</b>\n` : '') +
        `📦 Volume Anda: <b>${targetQty}</b>` + (leaderPos.amount > 0 ? ` <i>(Leader: ${leaderPos.amount})</i>` : '') + `\n` +
        `⚡ Leverage: <b>${leaderPos.leverage || 10}x (${leaderPos.marginType || 'CROSSED'})</b>\n` +
        `💰 Margin Akun Anda: <b>$${estMargin.toFixed(2)} USDT</b>\n` +
        (leaderMargin > 0 ? `👤 Margin Leader: <b>$${leaderMargin.toFixed(2)} USDT</b>\n` : '') +
        `👤 Target Leader: <code>${this.config.portfolioId}</code>`
      );
      return virtualPos;
    }

    try {
      // Sinkronisasi leverage jika diaktifkan
      if (this.config.syncLeverage && leaderPos.leverage > 0) {
        await binanceClient.setLeverage(leaderPos.symbol, leaderPos.leverage);
        await binanceClient.setMarginType(leaderPos.symbol, leaderPos.marginType);
      }

      // Eksekusi order buka posisi riil di Binance
      this.log('INFO', `🚀 Mengirim order MARKET: ${side} ${targetQty} ${leaderPos.symbol} (${userPositionSide})...`);
      const orderRes = await binanceClient.placeMarketOrder(leaderPos.symbol, side, targetQty, false, userPositionSide);
      this.log('SUCCESS', `✅ Order BERHASIL dieksekusi! ID: ${orderRes.orderId || 'OK'} (${side} ${targetQty} ${leaderPos.symbol} ${userPositionSide})`);
      const estMargin = (targetQty * markPrice) / (leaderPos.leverage || 10);
      const leaderMargin = (leaderPos.amount > 0 && (leaderPos.entryPrice > 0 || markPrice > 0)) ? (leaderPos.amount * (leaderPos.entryPrice || markPrice)) / Math.max(1, leaderPos.leverage || 10) : 0;
      const title = isAveragingDown
        ? 'ORDER AVERAGING DOWN [🟢 LIVE FUTURES]'
        : (isInverse ? 'ORDER COPY TRADE DIBUKA [🟢 LIVE - 🔄 INVERSE]' : 'ORDER COPY TRADE DIBUKA [🟢 LIVE FUTURES]');
      this.sendTelegram(
        `🚀 <b>${title}</b>\n\n` +
        `🪙 Simbol: <b>${leaderPos.symbol}</b>\n` +
        `📊 Posisi Akun: <b>${userPositionSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>${isInverse ? ' <i>(🔄 Inversi Fade Leader)</i>' : ''}\n` +
        `👤 Arah Leader: <b>${leaderPos.positionSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
        (leaderPos.entryPrice > 0 ? `🎯 Entry Leader: <b>$${leaderPos.entryPrice}</b>\n` : '') +
        `💵 Entry Anda: <b>$${markPrice}</b>\n` +
        `📍 Harga Mark: <b>$${markPrice}</b>\n` +
        (favorableSlippagePct > 0 ? `🔥 Slippage Plus: <b>Diskon +${favorableSlippagePct.toFixed(2)}% Lebih Murah dari Leader!</b>\n` : '') +
        `📦 Volume Anda: <b>${targetQty}</b>` + (leaderPos.amount > 0 ? ` <i>(Leader: ${leaderPos.amount})</i>` : '') + `\n` +
        `⚡ Leverage: <b>${leaderPos.leverage || 10}x (${leaderPos.marginType || 'CROSSED'})</b>\n` +
        `💰 Margin Akun Anda: <b>$${estMargin.toFixed(2)} USDT</b>\n` +
        (leaderMargin > 0 ? `👤 Margin Leader: <b>$${leaderMargin.toFixed(2)} USDT</b>\n` : '') +
        `👤 Target Leader: <code>${this.config.portfolioId}</code>`
      );

      const newUserPos: UserPosition = {
        symbol: leaderPos.symbol,
        positionSide: userPositionSide,
        positionAmt: userPositionSide === 'LONG' ? targetQty : -targetQty,
        entryPrice: markPrice,
        markPrice: markPrice,
        unRealizedProfit: 0,
        leverage: leaderPos.leverage || 10,
        marginType: leaderPos.marginType || 'CROSSED',
        notional: targetQty * markPrice,
        margin: estMargin,
        avgCount: 0,
      };
      return newUserPos;
    } catch (e: any) {
      const errMsg = e.response?.data?.msg || e.message;
      this.log('ERROR', `❌ Gagal eksekusi order ${leaderPos.symbol}: ${errMsg}`);
      this.sendTelegram(
        `⚠️ <b>ORDER GAGAL DIEKSEKUSI [🟢 LIVE FUTURES]</b>\n\n` +
        `🪙 Simbol: <b>${leaderPos.symbol}</b> (${leaderPos.positionSide})\n` +
        `⚡ Aksi: Buka Posisi (${side} ${targetQty})\n` +
        `❌ Error: <code>${errMsg}</code>\n` +
        `💡 Tips: Periksa saldo margin USDT atau batasan akun di Binance Anda.`
      );
      return null;
    }
  }

  private async handleAveraging(
    leaderPos: LeadPosition,
    deltaAmount: number,
    prevTotalLeaderQty: number,
    userBalance: number,
    existingUserPos?: UserPosition
  ): Promise<{ addedQty: number; newTotalQty: number; newEntryPrice: number } | null> {
    if (!this.config.paperTrading && !binanceClient.isConfigured()) return null;
    if (!existingUserPos) return null;

    const userCurrentQty = Math.abs(existingUserPos.positionAmt);
    if (userCurrentQty <= 0) return null;

    // Hitung penambahan proporsional
    const addRatio = prevTotalLeaderQty > 0 ? (deltaAmount / prevTotalLeaderQty) : 1;
    let addQty = userCurrentQty * addRatio;

    const filter = await binanceClient.getSymbolFilter(leaderPos.symbol);
    const markPrice = leaderPos.markPrice > 0 ? leaderPos.markPrice : leaderPos.entryPrice;

    // Slippage Guard pada order averaging down (Directional Asymmetric)
    const userSide = existingUserPos.positionSide;
    let adverseSlippagePct = 0;
    let favorableSlippagePct = 0;

    if (leaderPos.entryPrice > 0 && markPrice > 0) {
      if (userSide === 'LONG') {
        if (markPrice > leaderPos.entryPrice) {
          adverseSlippagePct = ((markPrice - leaderPos.entryPrice) / leaderPos.entryPrice) * 100;
        } else {
          favorableSlippagePct = ((leaderPos.entryPrice - markPrice) / leaderPos.entryPrice) * 100;
        }
      } else {
        // SHORT
        if (markPrice < leaderPos.entryPrice) {
          adverseSlippagePct = ((leaderPos.entryPrice - markPrice) / leaderPos.entryPrice) * 100;
        } else {
          favorableSlippagePct = ((markPrice - leaderPos.entryPrice) / leaderPos.entryPrice) * 100;
        }
      }

      const allowedAdversePct = this.config.zeroSlippageOnly ? 0.01 : (this.config.maxSlippagePct || 0.5);

      if (adverseSlippagePct > allowedAdversePct) {
        const posKey = `${leaderPos.symbol}_${leaderPos.positionSide}`;
        this.slippageSkippedOrders.set(posKey, {
          symbol: leaderPos.symbol,
          positionSide: leaderPos.positionSide,
          type: 'AVERAGING',
          leaderEntryPrice: leaderPos.entryPrice,
          markPrice: markPrice,
          slippagePct: adverseSlippagePct,
          adverseSlippagePct,
          targetPullbackPrice: leaderPos.entryPrice,
          isSniperPending: true,
          notifiedSniper: true,
          skippedAt: Date.now(),
          reason: `Averaging market price ($${markPrice}) lebih buruk +${adverseSlippagePct.toFixed(2)}% dibanding entry leader ($${leaderPos.entryPrice}). Auto-Sniper aktif memantau pullback.`,
        });
        this.saveVirtualState();

        const windowMins = this.config.reorderWindowMinutes || 30;
        const targetOp = userSide === 'LONG' ? '≤' : '≥';
        this.log('WARN', `🎯 [AUTO-SNIPER AVG AKTIF] Averaging ${leaderPos.symbol} (${userSide}) ditahan: Harga pasar ($${markPrice}) lebih buruk +${adverseSlippagePct.toFixed(2)}% dari entry leader ($${leaderPos.entryPrice}). Bot memantau pullback ke ${targetOp} $${leaderPos.entryPrice}.`);
        this.sendTelegramRateLimited(
          `SLIPPAGE_AVG_${posKey}`,
          `🎯 <b>AVERAGING DITAHAN - AUTO-SNIPER PULLBACK AKTIF</b>\n\n` +
          `🪙 Simbol: <b>${leaderPos.symbol}</b> (${userSide})\n` +
          `👤 Entry Leader: <b>$${leaderPos.entryPrice}</b>\n` +
          `📈 Harga Pasar Saat Ini: <b>$${markPrice}</b>\n` +
          `⚠️ Selisih Kurang Menguntungkan: <b>+${adverseSlippagePct.toFixed(2)}%</b>\n\n` +
          `🛡️ <i>Sistem menahan penambahan layer demi memastikan harga averaging sama atau lebih menguntungkan. Bot memantau chart dan akan <b>OTOMATIS MENAMBAH LAYER</b> begitu harga pullback ke <b>${targetOp} $${leaderPos.entryPrice}</b>.</i>`,
          60000
        );
        return null;
      }
    }

    // Safety Cap check berdasarkan Margin modal
    const lev = Math.max(1, leaderPos.leverage || 10);
    const currentMargin = ((userCurrentQty + addQty) * markPrice) / lev;
    if (this.config.maxModalPerCoin > 0 && currentMargin > this.config.maxModalPerCoin) {
      const maxNotional = this.config.maxModalPerCoin * lev;
      addQty = Math.max(0, (maxNotional - userCurrentQty * markPrice) / markPrice);
      if (addQty <= 0) {
        this.log('WARN', `🛡️ Safety Cap Tercapai untuk ${leaderPos.symbol} (Maks Margin: $${this.config.maxModalPerCoin} USDT). Tidak menambah posisi lagi.`);
        return null;
      }
    }

    addQty = binanceClient.roundQuantity(addQty, filter.stepSize);

    // Proteksi minQty & minNotional ($5 USDT rule Binance Futures)
    if (addQty < filter.minQty) {
      addQty = filter.minQty;
    }
    if (addQty * markPrice < filter.minNotional) {
      const minQtyForNotional = binanceClient.roundQuantity(Math.ceil((filter.minNotional * 1.05) / markPrice / filter.stepSize) * filter.stepSize, filter.stepSize);
      const testMargin = ((userCurrentQty + minQtyForNotional) * markPrice) / lev;
      if (this.config.maxModalPerCoin <= 0 || testMargin <= this.config.maxModalPerCoin) {
        addQty = minQtyForNotional;
      } else {
        this.log('WARN', `⚠️ Kuantitas averaging ${leaderPos.symbol} (${addQty}) di bawah batas minimum Binance ($${filter.minNotional} USDT / ${filter.minQty}) dan menaikkannya melanggar Safety Cap. Averaging dilewati.`);
        return null;
      }
    }

    if (this.config.paperTrading) {
      const leaderKey = `${leaderPos.symbol}_${leaderPos.positionSide}`;
      const userKey = `${existingUserPos.symbol}_${existingUserPos.positionSide}`;
      const counts = this.positionAvgCounts.get(userKey) || this.positionAvgCounts.get(leaderKey) || { leader: 0, user: 0 };
      counts.leader = Math.max((counts.leader || 0) + 1, leaderPos.avgCount || 0);
      counts.user = (counts.user || 0) + 1;
      this.positionAvgCounts.set(leaderKey, counts);
      this.positionAvgCounts.set(userKey, counts);

      const oldQty = Math.abs(existingUserPos.positionAmt);
      const newQty = oldQty + addQty;
      const newEntry = (oldQty * existingUserPos.entryPrice + addQty * markPrice) / newQty;
      const lev = Math.max(1, existingUserPos.leverage || 10);
      existingUserPos.positionAmt = existingUserPos.positionSide === 'LONG' ? newQty : -newQty;
      existingUserPos.entryPrice = newEntry;
      existingUserPos.notional = newQty * markPrice;
      existingUserPos.margin = (newQty * newEntry) / lev;
      existingUserPos.avgCount = counts.user;
      this.virtualPositions.set(userKey, existingUserPos);
      this.saveVirtualState();
      const addMargin = (addQty * markPrice) / lev;
      const newTotalMargin = (newQty * newEntry) / lev;
      const leaderMargin = (leaderPos.amount > 0 && (leaderPos.entryPrice > 0 || markPrice > 0)) ? (leaderPos.amount * (leaderPos.entryPrice || markPrice)) / Math.max(1, leaderPos.leverage || 10) : 0;
      this.log('SUCCESS', `🧪 [MODE SIMULASI] Virtual Averaging Berhasil (ke-${counts.user}x): ${leaderPos.symbol} (${existingUserPos.positionSide}) (+${addQty}, total: ${newQty.toFixed(4)} @ $${newEntry.toFixed(2)})`);
      this.sendTelegram(
        `➕ <b>ORDER AVERAGING DOWN [🧪 SIMULASI]</b>\n\n` +
        `🪙 Simbol: <b>${leaderPos.symbol}</b>\n` +
        `📊 Arah Akun: <b>${existingUserPos.positionSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
        `🔄 Averaging Down: <b>ke-${counts.user}x (${counts.user + 1} Layer)</b>\n` +
        `💵 Harga Eksekusi: <b>$${markPrice}</b>\n` +
        `📍 Harga Mark: <b>$${markPrice}</b>\n` +
        `🎯 Entry Price Baru: <b>$${newEntry.toFixed(2)}</b>\n` +
        `📦 Tambahan Volume: <b>+${addQty}</b> (Total: ${newQty.toFixed(4)})\n` +
        `⚡ Leverage: <b>${leaderPos.leverage || 10}x</b>\n` +
        `💵 Tambahan Margin: <b>+$${addMargin.toFixed(2)} USDT</b>\n` +
        `💰 Total Margin Posisi: <b>$${newTotalMargin.toFixed(2)} USDT</b>\n` +
        (leaderMargin > 0 ? `👤 Margin Leader: <b>$${leaderMargin.toFixed(2)} USDT</b>\n` : '') +
        `👤 Target Leader: <code>${this.config.portfolioId}</code>`
      );
      return { addedQty: addQty, newTotalQty: newQty, newEntryPrice: newEntry };
    }

    try {
      const leaderKey = `${leaderPos.symbol}_${leaderPos.positionSide}`;
      const userKey = `${existingUserPos.symbol}_${existingUserPos.positionSide}`;
      const counts = this.positionAvgCounts.get(userKey) || this.positionAvgCounts.get(leaderKey) || { leader: 0, user: 0 };
      const nextUserCount = (counts.user || 0) + 1;

      const userSide = existingUserPos.positionSide;
      const side: 'BUY' | 'SELL' = userSide === 'LONG' ? 'BUY' : 'SELL';
      this.log('INFO', `➕ Menambah posisi (Averaging Down ke-${nextUserCount}x) ${leaderPos.symbol} (${userSide}) sebanyak ${addQty}...`);
      await binanceClient.placeMarketOrder(leaderPos.symbol, side, addQty, false, userSide);

      counts.leader = Math.max((counts.leader || 0) + 1, leaderPos.avgCount || 0);
      counts.user = nextUserCount;
      this.positionAvgCounts.set(leaderKey, counts);
      this.positionAvgCounts.set(userKey, counts);
      this.saveVirtualState();

      // MUTASI MEMORY STATE USER POSISI AGAR TIDAK MENGGUNAKAN KUANTITAS LAMA
      const oldQty = Math.abs(existingUserPos.positionAmt);
      const newQty = oldQty + addQty;
      const newEntry = (oldQty * existingUserPos.entryPrice + addQty * markPrice) / newQty;
      const lev = Math.max(1, existingUserPos.leverage || 10);
      existingUserPos.positionAmt = userSide === 'LONG' ? newQty : -newQty;
      existingUserPos.entryPrice = newEntry;
      existingUserPos.notional = newQty * markPrice;
      existingUserPos.margin = (newQty * newEntry) / lev;
      existingUserPos.avgCount = nextUserCount;

      const addMargin = (addQty * markPrice) / lev;
      const newTotalMargin = (newQty * newEntry) / lev;
      const leaderMargin = (leaderPos.amount > 0 && (leaderPos.entryPrice > 0 || markPrice > 0)) ? (leaderPos.amount * (leaderPos.entryPrice || markPrice)) / Math.max(1, leaderPos.leverage || 10) : 0;

      this.log('SUCCESS', `✅ Berhasil menambah posisi (Averaging Down ke-${nextUserCount}x) ${leaderPos.symbol} (${userSide}, +${addQty})`);
      this.sendTelegram(
        `➕ <b>ORDER AVERAGING DOWN [🟢 LIVE FUTURES]</b>\n\n` +
        `🪙 Simbol: <b>${leaderPos.symbol}</b>\n` +
        `📊 Arah Akun: <b>${userSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
        `🔄 Averaging Down: <b>ke-${counts.user}x (${counts.user + 1} Layer)</b>\n` +
        `💵 Harga Pasar: <b>$${markPrice}</b>\n` +
        `📍 Harga Mark: <b>$${markPrice}</b>\n` +
        `🎯 Entry Price Baru: <b>$${newEntry.toFixed(2)}</b>\n` +
        `📦 Tambahan Volume: <b>+${addQty}</b> (Total: ${newQty.toFixed(4)})\n` +
        `⚡ Leverage: <b>${leaderPos.leverage || 10}x</b>\n` +
        `💵 Tambahan Margin: <b>+$${addMargin.toFixed(2)} USDT</b>\n` +
        `💰 Total Margin Posisi: <b>$${newTotalMargin.toFixed(2)} USDT</b>\n` +
        (leaderMargin > 0 ? `👤 Margin Leader: <b>$${leaderMargin.toFixed(2)} USDT</b>\n` : '') +
        `👤 Target Leader: <code>${this.config.portfolioId}</code>`
      );
      return { addedQty: addQty, newTotalQty: newQty, newEntryPrice: newEntry };
    } catch (e: any) {
      const leaderKey = `${leaderPos.symbol}_${leaderPos.positionSide}`;
      const userKey = `${existingUserPos.symbol}_${existingUserPos.positionSide}`;
      const counts = this.positionAvgCounts.get(userKey) || this.positionAvgCounts.get(leaderKey) || { leader: 0, user: 0 };
      counts.leader = Math.max((counts.leader || 0) + 1, leaderPos.avgCount || 0);
      this.positionAvgCounts.set(leaderKey, counts);
      this.positionAvgCounts.set(userKey, counts);
      this.saveVirtualState();

      const errMsg = e.response?.data?.msg || e.message;
      this.log('ERROR', `Gagal menambah posisi ${leaderPos.symbol}: ${errMsg}`);
      this.sendTelegram(
        `⚠️ <b>ORDER AVERAGING GAGAL [🟢 LIVE FUTURES]</b>\n\n` +
        `🪙 Simbol: <b>${leaderPos.symbol}</b> (${leaderPos.positionSide})\n` +
        `❌ Error: <code>${errMsg}</code>`
      );
      return null;
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
    let exitPrice = 0;
    try {
      exitPrice = await binanceClient.getSymbolPrice(leaderPos.symbol);
    } catch {}
    if (!exitPrice || exitPrice <= 0) {
      exitPrice = leaderPos.markPrice > 0 ? leaderPos.markPrice : (existingUserPos.markPrice > 0 ? existingUserPos.markPrice : existingUserPos.entryPrice);
    }

    const posKey = `${leaderPos.symbol}_${existingUserPos.positionSide}`;
    const filter = await binanceClient.getSymbolFilter(leaderPos.symbol);
    const minCloseQty = binanceClient.roundQuantity(Math.ceil((filter.minNotional * 1.05) / exitPrice / filter.stepSize) * filter.stepSize, filter.stepSize);
    let closeQty = binanceClient.roundQuantity(userCurrentQty * closeRatio, filter.stepSize);

    // Proteksi Dust (< $5 USDT) & Smart Full Close (Leader tutup >= 90%)
    const remainingQty = Math.max(0, userCurrentQty - closeQty);
    const remainingNotional = remainingQty * exitPrice;
    const isDustOrFull = closeRatio >= 0.90 || remainingNotional < filter.minNotional || remainingQty < filter.minQty;

    if (isDustOrFull) {
      closeQty = binanceClient.roundQuantity(userCurrentQty, filter.stepSize);
    } else if (closeQty * exitPrice < filter.minNotional) {
      // Jika partial close di bawah $5 USDT, naikkan ke minCloseQty jika sisa masih cukup, atau tutup 100% jika sisa receh
      if ((userCurrentQty - minCloseQty) * exitPrice < filter.minNotional || userCurrentQty <= minCloseQty) {
        closeQty = binanceClient.roundQuantity(userCurrentQty, filter.stepSize);
      } else {
        closeQty = minCloseQty;
      }
    }

    if (closeQty < filter.minQty) return;

    const pnl = existingUserPos.positionSide === 'LONG'
      ? (exitPrice - existingUserPos.entryPrice) * closeQty
      : (existingUserPos.entryPrice - exitPrice) * closeQty;
    const pnlPct = existingUserPos.entryPrice > 0
      ? ((exitPrice - existingUserPos.entryPrice) / existingUserPos.entryPrice) * (existingUserPos.positionSide === 'LONG' ? 1 : -1) * 100 * (existingUserPos.leverage || 10)
      : 0;

    let partialCloseSucceeded = false;
    if (this.config.paperTrading) {
      const oldQty = Math.abs(existingUserPos.positionAmt);
      const remainingQty = Math.max(0, oldQty - closeQty);
      this.virtualWalletBalance += pnl;
      if (remainingQty <= 0 || closeQty >= oldQty) {
        this.virtualPositions.delete(posKey);
        this.positionAvgCounts.delete(posKey);
        this.streamLeaderPositions.delete(posKey);
      } else {
        existingUserPos.positionAmt = existingUserPos.positionSide === 'LONG' ? remainingQty : -remainingQty;
        existingUserPos.notional = remainingQty * exitPrice;
        existingUserPos.margin = (remainingQty * (existingUserPos.entryPrice || exitPrice)) / Math.max(1, existingUserPos.leverage || 10);
        this.virtualPositions.set(posKey, existingUserPos);
      }
      this.saveVirtualState();
      this.log('SUCCESS', `🧪 [MODE SIMULASI] Virtual Partial Close: ${leaderPos.symbol} (-${closeQty}). PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDT (Saldo virtual: $${this.virtualWalletBalance.toFixed(2)} USDT)`);
      partialCloseSucceeded = true;
    } else {
      try {
        const side: 'LONG' | 'SHORT' = (existingUserPos.positionSide === 'LONG' || existingUserPos.positionSide === 'SHORT')
          ? existingUserPos.positionSide
          : (existingUserPos.positionAmt > 0 ? 'LONG' : 'SHORT');
        this.log('INFO', `✂️ Menutup parsial ${leaderPos.symbol} (${(closeRatio * 100).toFixed(1)}%, Vol: ${closeQty})...`);
        await binanceClient.closePosition(leaderPos.symbol, side, closeQty);
        if (closeQty >= userCurrentQty) {
          this.positionAvgCounts.delete(posKey);
          this.streamLeaderPositions.delete(posKey);
          this.saveVirtualState();
        }
        this.log('SUCCESS', `✅ Sukses partial close ${leaderPos.symbol} (${closeQty})`);
        partialCloseSucceeded = true;
      } catch (e: any) {
        const errMsg = e.response?.data?.msg || e.message;
        this.log('ERROR', `Gagal partial close ${leaderPos.symbol}: ${errMsg}`);
        this.sendTelegram(
          `⚠️ <b>GAGAL PARTIAL CLOSE [🟢 LIVE FUTURES]</b>\n\n` +
          `🪙 Simbol: <b>${leaderPos.symbol}</b> (${existingUserPos.positionSide})\n` +
          `❌ Error: <code>${errMsg}</code>`
        );
      }
    }

    if (partialCloseSucceeded) {
      const remainingQty = Math.max(0, userCurrentQty - closeQty);
      existingUserPos.positionAmt = existingUserPos.positionSide === 'LONG' ? remainingQty : -remainingQty;
      existingUserPos.notional = remainingQty * exitPrice;
      this.recordClosedTrade({
        symbol: leaderPos.symbol,
        positionSide: existingUserPos.positionSide as any,
        action: (closeQty >= userCurrentQty) ? 'FULL_CLOSE' : 'PARTIAL_CLOSE',
        qty: closeQty,
        entryPrice: existingUserPos.entryPrice,
        closePrice: exitPrice,
        realizedPnl: Number(pnl.toFixed(2)),
        pnlPct: Number(pnlPct.toFixed(2)),
        isPaper: this.config.paperTrading,
      });
    }
  }

  private async handleFullClose(leaderPos: LeadPosition, existingUserPos: UserPosition): Promise<boolean> {
    const filter = await binanceClient.getSymbolFilter(existingUserPos.symbol);
    const qty = binanceClient.roundQuantity(Math.abs(existingUserPos.positionAmt), filter.stepSize);
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

    let fullCloseSucceeded = false;
    if (this.config.paperTrading) {
      const posKey = `${existingUserPos.symbol}_${side}`;
      this.virtualWalletBalance += pnl;
      this.virtualPositions.delete(posKey);
      this.positionAvgCounts.delete(posKey);
      this.saveVirtualState();
      this.log('SUCCESS', `🧪 [MODE SIMULASI] Virtual Posisi ${existingUserPos.symbol} ${side} DITUTUP LENGKAP! PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDT. Saldo simulasi: $${this.virtualWalletBalance.toFixed(2)} USDT`);
      fullCloseSucceeded = true;
    } else {
      const posKey = `${existingUserPos.symbol}_${side}`;
      try {
        this.log('INFO', `🚪 Mengirim order Market Close untuk ${existingUserPos.symbol} (Qty: ${qty})...`);
        await binanceClient.closePosition(existingUserPos.symbol, side, qty);
        this.positionAvgCounts.delete(posKey);
        this.log('SUCCESS', `✅ Posisi ${existingUserPos.symbol} ${side} BERHASIL DITUTUP SEMPURNA!`);
        fullCloseSucceeded = true;
      } catch (e: any) {
        const errMsg = e.response?.data?.msg || e.message;
        this.log('ERROR', `Gagal menutup posisi ${existingUserPos.symbol}: ${errMsg}`);
        this.sendTelegram(
          `🚨 <b>CRITICAL: GAGAL MENUTUP POSISI [🟢 LIVE FUTURES]</b>\n\n` +
          `🪙 Simbol: <b>${existingUserPos.symbol}</b> (${side})\n` +
          `❌ Error: <code>${errMsg}</code>\n` +
          `⚠️ Leader sudah menutup posisi ini! Harap segera periksa dan tutup manual di Binance.`
        );
      }
    }

    if (fullCloseSucceeded) {
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
    return fullCloseSucceeded;
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
      this.positionAvgCounts.clear();
      this.streamLeaderPositions.clear();
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
      const errors: string[] = [];
      for (const p of positions) {
        try {
          const side: 'LONG' | 'SHORT' = (p.positionSide === 'LONG' || p.positionSide === 'SHORT')
            ? p.positionSide
            : (p.positionAmt > 0 ? 'LONG' : 'SHORT');
          const filter = await binanceClient.getSymbolFilter(p.symbol);
          const qty = binanceClient.roundQuantity(Math.abs(p.positionAmt), filter.stepSize);
          await binanceClient.closePosition(p.symbol, side, qty);
          const posKey = `${p.symbol}_${side}`;
          this.positionAvgCounts.delete(posKey);
          this.streamLeaderPositions.delete(posKey);
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
        } catch (err: any) {
          const errMsg = err.response?.data?.msg || err.message;
          errors.push(`${p.symbol}: ${errMsg}`);
          this.log('ERROR', `Gagal menutup posisi ${p.symbol} saat panic close: ${errMsg}`);
        }
      }
      this.saveVirtualState();

      if (errors.length > 0 && count === 0) {
        throw new Error(`Gagal panic close: ${errors.join(', ')}`);
      }

      this.log('SUCCESS', `✅ Berhasil menutup ${count} posisi terbuka secara darurat!${errors.length > 0 ? ` (${errors.length} koin gagal)` : ''}`);
      return `Berhasil menutup ${count} posisi terbuka.${errors.length > 0 ? ` Perhatian: ${errors.join(', ')}` : ''}`;
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
      if (!this.isHolidayAborted && this.config.weekendBreak?.enabled && weekendStatus.isWeekendWIB && this.config.weekendBreak.blockNewTrades !== false) {
        this.log('WARN', `🌴 [TEST ORDER DITOLAK] Order uji coba ${symbol} ${positionSide} diblokir oleh Mode Libur Akhir Pekan (Waktu WIB: ${weekendStatus.wibTimeStr}). Sistem berjalan normal menolak order baru saat libur!`);
        return {
          success: false,
          blockedByWeekend: true,
          message: `Order uji coba ${symbol} ${positionSide} DITOLAK oleh Mode Libur Akhir Pekan (Waktu WIB: ${weekendStatus.wibTimeStr}). Sistem bekerja dengan benar mengamankan akun dari trading akhir pekan! Centang opsi "Bypass Libur Akhir Pekan" jika ingin memaksa order masuk.`,
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

  /**
   * Pemantau Otomatis Auto-Sniper Pullback:
   * Memeriksa order tertahan (karena slippage sebelumnya) pada setiap siklus tick.
   * Jika harga pasar pullback menyentuh level entry leader atau lebih murah (Slippage 0 atau Plus),
   * bot otomatis mengeksekusi order tanpa perlu intervensi manual!
   */
  private async checkAutoSniperPullback(
    currentLeaderMap: Map<string, LeadPosition>,
    userBalance: number,
    userPositionsMap: Map<string, UserPosition>,
    userPositionsList?: UserPosition[]
  ): Promise<void> {
    if (this.config.sniperPullbackEnabled === false || this.slippageSkippedOrders.size === 0) {
      return;
    }

    const windowMinutes = Math.max(1, this.config.reorderWindowMinutes || 30);
    const windowMs = windowMinutes * 60 * 1000;
    const now = Date.now();

    for (const [posKey, item] of Array.from(this.slippageSkippedOrders.entries())) {
      // 1. Cek apakah posisi leader masih ada di bursa
      const leaderPos = currentLeaderMap.get(posKey) || this.streamLeaderPositions.get(posKey);
      if (!leaderPos || leaderPos.amount <= 0) {
        // Leader sudah menutup posisi ini sebelum harga sempat pullback!
        this.slippageSkippedOrders.delete(posKey);
        this.saveVirtualState();
        this.log('INFO', `ℹ️ [AUTO-SNIPER DIBATALKAN] Leader telah menutup posisi ${item.symbol} (${item.positionSide}) sebelum harga pullback. Antrean sniper dibatalkan aman tanpa risiko.`);
        this.sendTelegram(
          `ℹ️ <b>[AUTO-SNIPER DIBATALKAN]</b>\n\n` +
          `🪙 Simbol: <b>${item.symbol}</b> (${item.positionSide})\n` +
          `👤 Status Leader: <b>Posisi Telah Ditutup di Bursa</b>\n` +
          `🛡️ <i>Order tertahan otomatis dibatalkan karena leader sudah tidak memegang posisi ini. Akun Anda aman dan terhindar dari membuka posisi sendirian!</i>`
        );
        continue;
      }

      // 2. Cek batas toleransi waktu (reorderWindowMinutes)
      const elapsedMs = now - item.skippedAt;
      if (elapsedMs > windowMs) {
        this.slippageSkippedOrders.delete(posKey);
        this.saveVirtualState();
        this.log('WARN', `⏱️ [AUTO-SNIPER KADALUARSA] Batas waktu toleransi ${windowMinutes} menit untuk ${item.symbol} telah berakhir. Antrean dibersihkan.`);
        continue;
      }

      // 3. Ambil harga mark realtime bursa
      let markPrice = leaderPos.markPrice || 0;
      try {
        const fetchedPrice = await binanceClient.getSymbolPrice(item.symbol);
        if (fetchedPrice > 0) markPrice = fetchedPrice;
      } catch {}

      if (markPrice <= 0) continue;

      // 4. Tentukan arah akun user
      const isInverse = Boolean(this.config.reverseTrading);
      const targetUserSide: 'LONG' | 'SHORT' = isInverse
        ? (item.positionSide === 'LONG' ? 'SHORT' : 'LONG')
        : item.positionSide;
      const targetPrice = item.targetPullbackPrice || item.leaderEntryPrice;

      // 5. Cek apakah kondisi Pullback (Slippage 0 / Diskon / batas toleransi) sudah terpenuhi
      let isPullbackMatched = false;
      let discountPct = 0;
      const allowedAdversePct = this.config.zeroSlippageOnly ? 0.01 : (this.config.maxSlippagePct || 0.5);

      if (targetUserSide === 'LONG') {
        const thresholdPrice = targetPrice * (1 + (allowedAdversePct / 100));
        if (markPrice <= thresholdPrice) {
          isPullbackMatched = true;
          discountPct = ((targetPrice - markPrice) / targetPrice) * 100;
        }
      } else {
        // SHORT
        const thresholdPrice = targetPrice * (1 - (allowedAdversePct / 100));
        if (markPrice >= thresholdPrice) {
          isPullbackMatched = true;
          discountPct = ((markPrice - targetPrice) / targetPrice) * 100;
        }
      }

      if (isPullbackMatched) {
        this.log('SUCCESS', `🎯 [AUTO-SNIPER PULLBACK MATCH!] Harga ${item.symbol} telah pullback ke $${markPrice} (Target: $${targetPrice}, Diskon: ${discountPct > 0 ? `+${discountPct.toFixed(2)}% Lebih Murah` : '0%'}!). Mengeksekusi order otomatis...`);

        if (item.type === 'NEW_POSITION') {
          // Proteksi anti-dobel jika akun sudah memiliki posisi
          const { userPos } = this.getUserPositionForLeader(item.symbol, item.positionSide, userPositionsMap);
          if (userPos && Math.abs(userPos.positionAmt) > 0) {
            this.slippageSkippedOrders.delete(posKey);
            this.saveVirtualState();
            continue;
          }

          try {
            const res = await this.syncNewPosition(item.symbol, item.positionSide, true, isInverse, true, leaderPos);
            if (res.success) {
              const executedPrice = res.price || markPrice;
              const executedQty = res.qty || 0;
              const lev = leaderPos?.leverage || 10;
              const usedMargin = (executedQty * executedPrice) / lev;
              const leaderMargin = (leaderPos && leaderPos.amount > 0 && leaderPos.entryPrice > 0)
                ? (leaderPos.amount * leaderPos.entryPrice) / Math.max(1, leaderPos.leverage || 10)
                : 0;
              const discountText = discountPct > 0
                ? `🔥 Diskon +${discountPct.toFixed(2)}% Lebih Murah dari Leader!`
                : (discountPct >= 0 ? `0.00% (Identik Harga Leader)` : `Toleransi Slippage: ${discountPct.toFixed(2)}%`);

              if (res.position) {
                userPositionsMap.set(`${res.position.symbol}_${res.position.positionSide}`, res.position);
                if (userPositionsList) {
                  const existingIdx = userPositionsList.findIndex(
                    (u) => `${u.symbol}_${u.positionSide}` === `${res.position!.symbol}_${res.position!.positionSide}`
                  );
                  if (existingIdx >= 0) {
                    userPositionsList[existingIdx] = res.position;
                  } else {
                    userPositionsList.push(res.position);
                  }
                }
              }

              this.sendTelegram(
                `🎯 <b>AUTO-SNIPER PULLBACK BERHASIL MASUK! [⚡ SLIPPAGE 0/PLUS]</b>\n\n` +
                `🪙 Simbol: <b>${item.symbol}</b>\n` +
                `📊 Arah Akun: <b>${targetUserSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>${isInverse ? ' <i>(🔄 Inversi)</i>' : ''}\n` +
                `👤 Entry Leader: <b>$${targetPrice}</b>\n` +
                `🎯 Entry Akun Anda: <b>$${executedPrice}</b>\n` +
                `🔥 Hasil Slippage: <b>${discountText}</b>\n` +
                `📦 Kuantitas: <b>${executedQty}</b>\n` +
                `⚡ Leverage: <b>${lev}x</b>\n` +
                `💰 Margin Terpakai: <b>$${usedMargin.toFixed(2)} USDT</b>\n` +
                (leaderMargin > 0 ? `👤 Margin Leader: <b>$${leaderMargin.toFixed(2)} USDT</b>\n` : '') +
                `⚡ Mode: <b>Auto-Sniper Pullback Fill</b>`
              );
            }
          } catch (err: any) {
            this.log('ERROR', `Auto-Sniper gagal eksekusi order ${item.symbol}: ${err.message}`);
          }
        } else if (item.type === 'AVERAGING') {
          try {
            const res = await this.syncAveragingDown(item.symbol, item.positionSide, leaderPos);
            if (res.success) {
              this.slippageSkippedOrders.delete(posKey);
              this.saveVirtualState();
              const addedQty = res.addQty || 0;
              const lev = leaderPos?.leverage || 10;
              const addedMargin = (addedQty * markPrice) / lev;
              const { userPos } = this.getUserPositionForLeader(item.symbol, item.positionSide, userPositionsMap);
              const totalMargin = userPos ? Math.abs(userPos.margin || (Math.abs(userPos.positionAmt) * (userPos.entryPrice || markPrice)) / lev) : addedMargin;
              const leaderMargin = (leaderPos && leaderPos.amount > 0 && leaderPos.entryPrice > 0)
                ? (leaderPos.amount * leaderPos.entryPrice) / Math.max(1, leaderPos.leverage || 10)
                : 0;

              this.sendTelegram(
                `🎯 <b>AUTO-SNIPER AVERAGING DOWN MATCH! [⚡ SLIPPAGE 0/PLUS]</b>\n\n` +
                `🪙 Simbol: <b>${item.symbol}</b> (${targetUserSide})\n` +
                `👤 Entry Leader: <b>$${targetPrice}</b>\n` +
                `🎯 Harga Eksekusi: <b>$${markPrice}</b>\n` +
                `📦 Tambahan Volume: <b>+${addedQty}</b>\n` +
                `⚡ Leverage: <b>${lev}x</b>\n` +
                `💵 Tambahan Margin: <b>+$${addedMargin.toFixed(2)} USDT</b>\n` +
                `💰 Total Margin Posisi: <b>$${totalMargin.toFixed(2)} USDT</b>\n` +
                (leaderMargin > 0 ? `👤 Margin Leader: <b>$${leaderMargin.toFixed(2)} USDT</b>\n` : '') +
                `⚡ Mode: <b>Auto-Sniper Pullback Averaging</b>`
              );
            }
          } catch (err: any) {
            this.log('ERROR', `Auto-Sniper gagal eksekusi averaging ${item.symbol}: ${err.message}`);
          }
        }
      }
    }
  }

  /**
   * Eksekusi manual untuk mengejar / sinkronisasi Averaging Down yang tertinggal
   */
  async syncAveragingDown(
    symbol: string,
    positionSide: 'LONG' | 'SHORT',
    leaderPosOverride?: LeadPosition
  ): Promise<{ success: boolean; message: string; addQty?: number }> {
    const sym = symbol.toUpperCase();
    const posKey = `${sym}_${positionSide}`;

    // Cek posisi leader
    const leaderPos = leaderPosOverride || this.streamLeaderPositions.get(posKey) || this.lastLeaderPositions.get(posKey);
    if (!leaderPos) {
      throw new Error(`Posisi leader untuk ${sym} ${positionSide} tidak ditemukan.`);
    }

    // Ambil saldo & posisi user saat ini
    let userBalance = 0;
    let userPositionsMap = new Map<string, UserPosition>();

    if (this.config.paperTrading) {
      userBalance = this.virtualWalletBalance;
      userPositionsMap = this.virtualPositions;
    } else if (binanceClient.isConfigured()) {
      const bal = await binanceClient.getAccountBalance();
      userBalance = bal.totalWalletBalance > 0 ? bal.totalWalletBalance : bal.availableBalance;
      const openPositions = await binanceClient.getOpenPositions();
      for (const op of openPositions) {
        userPositionsMap.set(`${op.symbol}_${op.positionSide}`, op);
      }
    }

    const { userPos } = this.getUserPositionForLeader(sym, positionSide, userPositionsMap);

    if (!userPos || Math.abs(userPos.positionAmt) <= 0) {
      throw new Error(`Akun Anda tidak memiliki posisi aktif ${sym} untuk di-average down.`);
    }

    const userSide = userPos.positionSide;
    const userPosKey = `${sym}_${userSide}`;
    const counts = this.positionAvgCounts.get(userPosKey) || this.positionAvgCounts.get(posKey) || { leader: 0, user: 0 };
    const userCurrentQty = Math.abs(userPos.positionAmt);

    // Hitung target kuantitas user berdasarkan rasio modal terhadap leader
    const leaderEquity = this.lastLeaderEquity > 0 ? this.lastLeaderEquity : 50000;
    let targetTotalQty = 0;

    if (this.config.mode === 'FIXED_AMOUNT') {
      const markPrice = await binanceClient.getSymbolPrice(sym) || leaderPos.entryPrice;
      const multiplier = Math.max(1, counts.leader + 1);
      targetTotalQty = (this.config.fixedAmountUsdt * multiplier) / markPrice;
    } else if (this.config.mode === 'FIXED_RATIO') {
      const markPrice = await binanceClient.getSymbolPrice(sym) || leaderPos.entryPrice;
      const multiplier = Math.max(1, counts.leader + 1);
      targetTotalQty = (userBalance * 0.05 * this.config.ratioMultiplier * multiplier) / markPrice;
    } else {
      // RATIO_EQUITY
      const equityRatio = (userBalance / leaderEquity) * this.config.ratioMultiplier;
      targetTotalQty = leaderPos.amount * equityRatio;
    }

    const filter = await binanceClient.getSymbolFilter(sym);
    let neededAddQty = Math.max(0, targetTotalQty - userCurrentQty);
    neededAddQty = binanceClient.roundQuantity(neededAddQty, filter.stepSize);

    if (neededAddQty <= 0) {
      counts.user = counts.leader;
      this.positionAvgCounts.set(posKey, counts);
      this.positionAvgCounts.set(userPosKey, counts);
      this.saveVirtualState();
      return {
        success: true,
        message: `Posisi ${sym} (${userSide}) sudah proporsional dengan leader. Status avg down disinkronkan (${counts.user}x).`,
      };
    }

    const markPrice = await binanceClient.getSymbolPrice(sym) || leaderPos.markPrice || leaderPos.entryPrice;

    // Safety Cap check
    const lev = Math.max(1, userPos.leverage || leaderPos.leverage || 10);
    const currentMargin = ((userCurrentQty + neededAddQty) * markPrice) / lev;
    if (this.config.maxModalPerCoin > 0 && currentMargin > this.config.maxModalPerCoin) {
      const maxNotional = this.config.maxModalPerCoin * lev;
      neededAddQty = Math.max(0, (maxNotional - userCurrentQty * markPrice) / markPrice);
      neededAddQty = binanceClient.roundQuantity(neededAddQty, filter.stepSize);
      if (neededAddQty <= 0) {
        throw new Error(`Safety Cap tercapai (Maks Margin: $${this.config.maxModalPerCoin} USDT). Tidak dapat menambah posisi lagi.`);
      }
    }

    // Min notional guard
    if (neededAddQty < filter.minQty) neededAddQty = filter.minQty;
    if (neededAddQty * markPrice < filter.minNotional) {
      const minQtyForNotional = binanceClient.roundQuantity(Math.ceil((filter.minNotional * 1.05) / markPrice / filter.stepSize) * filter.stepSize, filter.stepSize);
      const testMargin = ((userCurrentQty + minQtyForNotional) * markPrice) / lev;
      if (this.config.maxModalPerCoin <= 0 || testMargin <= this.config.maxModalPerCoin) {
        neededAddQty = minQtyForNotional;
      } else {
        throw new Error(`Kuantitas averaging ${sym} di bawah batas minimum Binance ($${filter.minNotional} USDT) dan menaikkannya melanggar Safety Cap ($${this.config.maxModalPerCoin} USDT).`);
      }
    }

    if (this.config.paperTrading) {
      const oldQty = Math.abs(userPos.positionAmt);
      const newQty = oldQty + neededAddQty;
      const newEntry = (oldQty * userPos.entryPrice + neededAddQty * markPrice) / newQty;
      counts.user = counts.leader > 0 ? counts.leader : (counts.user || 0) + 1;
      this.positionAvgCounts.set(posKey, counts);
      this.positionAvgCounts.set(userPosKey, counts);

      userPos.positionAmt = userSide === 'LONG' ? newQty : -newQty;
      userPos.entryPrice = newEntry;
      userPos.markPrice = markPrice;
      userPos.notional = newQty * markPrice;
      userPos.margin = (newQty * newEntry) / lev;
      userPos.avgCount = counts.user;
      this.virtualPositions.set(userPosKey, userPos);
      const updatedStream = this.streamLeaderPositions.get(posKey);
      if (updatedStream) updatedStream.avgCount = counts.user;
      this.slippageSkippedOrders.delete(posKey);
      this.slippageSkippedOrders.delete(userPosKey);
      this.saveVirtualState();
      this.log('SUCCESS', `🧪 [MANUAL SYNC AVG DOWN] Berhasil sinkronisasi virtual averaging ${sym} (${userSide}) (+${neededAddQty} @ $${markPrice})!`);
      this.sendTelegram(
        `⚡ <b>SINKRONISASI AVERAGING DOWN BERHASIL [🧪 SIMULASI]</b>\n\n` +
        `🪙 Simbol: <b>${sym}</b>\n` +
        `📊 Arah Akun: <b>${userSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
        `🔄 Status: <b>Disinkronkan ke ${counts.user}x (${counts.user + 1} Layer)</b>\n` +
        `💵 Harga: <b>$${markPrice}</b>\n` +
        `📦 Tambahan Volume: <b>+${neededAddQty}</b>\n` +
        `⚡ Mode: <b>Manual Sync Avg (Simulasi)</b>`
      );
      return {
        success: true,
        message: `✅ Berhasil sinkronisasi virtual averaging ${sym} (${userSide}) (+${neededAddQty} koin).`,
        addQty: neededAddQty,
      };
    }

    // Live Binance
    const side: 'BUY' | 'SELL' = userSide === 'LONG' ? 'BUY' : 'SELL';
    this.log('INFO', `⚡ [MANUAL SYNC AVG DOWN] Mengirim order averaging ke Binance: ${sym} ${side} ${neededAddQty} (${userSide})...`);
    const orderRes = await binanceClient.placeMarketOrder(sym, side, neededAddQty, false, userSide);
    counts.user = counts.leader > 0 ? counts.leader : (counts.user || 0) + 1;
    this.positionAvgCounts.set(posKey, counts);
    this.positionAvgCounts.set(userPosKey, counts);
    const updatedStream = this.streamLeaderPositions.get(posKey);
    if (updatedStream) updatedStream.avgCount = counts.user;
    this.slippageSkippedOrders.delete(posKey);
    this.slippageSkippedOrders.delete(userPosKey);
    this.saveVirtualState();

    this.log('SUCCESS', `✅ [MANUAL SYNC AVG DOWN] Berhasil mengeksekusi averaging down susulan pada ${sym} (${userSide}) (+${neededAddQty} @ $${markPrice})! Order ID: ${orderRes.orderId}`);
    this.sendTelegram(
      `⚡ <b>SINKRONISASI AVERAGING DOWN BERHASIL [🟢 LIVE FUTURES]</b>\n\n` +
      `🪙 Simbol: <b>${sym}</b>\n` +
      `📊 Arah Akun: <b>${userSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
      `🔄 Status: <b>Disinkronkan ke ${counts.user}x (${counts.user + 1} Layer)</b>\n` +
      `💵 Harga: <b>$${markPrice}</b>\n` +
      `📦 Tambahan Volume: <b>+${neededAddQty}</b>\n` +
      `⚡ Order ID: <code>${orderRes.orderId || 'OK'}</code>`
    );

    return {
      success: true,
      message: `✅ Berhasil mengeksekusi averaging down susulan pada ${sym} (${userSide}) (+${neededAddQty} koin)!`,
      addQty: neededAddQty,
    };
  }

  /**
   * Eksekusi order baru (re-order susulan / Auto-Sniper) untuk posisi yang sebelumnya dilewati karena slippage
   * Memiliki jendela batas toleransi waktu configurable (default 30 menit, misal 120 menit)
   * Mendukung opsi kebalikan/inverse (Leader Long -> User Short, Leader Short -> User Long)
   */
  async syncNewPosition(
    symbol: string,
    positionSide: 'LONG' | 'SHORT',
    force: boolean = false,
    invert?: boolean,
    isAutoSniper: boolean = false,
    leaderPosOverride?: LeadPosition
  ): Promise<{ success: boolean; message: string; position?: UserPosition; qty?: number; price?: number }> {
    const sym = symbol.toUpperCase();
    const posKey = `${sym}_${positionSide}`;

    // 1. Cek keberadaan posisi leader
    const leaderPos = leaderPosOverride || this.streamLeaderPositions.get(posKey) || this.lastLeaderPositions.get(posKey);
    if (!leaderPos) {
      throw new Error(`Posisi leader untuk ${sym} ${positionSide} tidak ditemukan atau sudah ditutup.`);
    }

    // Tentukan arah posisi untuk user (jika parameter invert diberikan eksplisit, gunakan invert; jika tidak, gunakan reverseTrading global)
    const isInverse = invert !== undefined ? Boolean(invert) : Boolean(this.config.reverseTrading);
    const targetUserSide: 'LONG' | 'SHORT' = isInverse
      ? (positionSide === 'LONG' ? 'SHORT' : 'LONG')
      : positionSide;
    const userPosKey = `${sym}_${targetUserSide}`;

    // 2. Ambil saldo & posisi user saat ini
    let userBalance = 0;
    let userPositionsMap = new Map<string, UserPosition>();

    if (this.config.paperTrading) {
      userBalance = this.virtualWalletBalance;
      userPositionsMap = this.virtualPositions;
    } else if (binanceClient.isConfigured()) {
      const bal = await binanceClient.getAccountBalance();
      userBalance = bal.totalWalletBalance > 0 ? bal.totalWalletBalance : bal.availableBalance;
      const openPositions = await binanceClient.getOpenPositions();
      for (const op of openPositions) {
        userPositionsMap.set(`${op.symbol}_${op.positionSide}`, op);
      }
    }

    const { userPos } = this.getUserPositionForLeader(sym, positionSide, userPositionsMap);

    // Jika user sudah memiliki posisi terbuka, arahkan ke Sync Avg
    if (userPos && Math.abs(userPos.positionAmt) > 0) {
      throw new Error(`Akun Anda sudah memiliki posisi terbuka pada ${sym} (${userPos.positionSide}). Gunakan tombol Sync Avg jika ingin menambah muatan.`);
    }

    // 3. Validasi batas jendela toleransi waktu (berdasarkan konfigurasi reorderWindowMinutes)
    const windowMinutes = Math.max(1, this.config.reorderWindowMinutes || 30);
    const windowMs = windowMinutes * 60 * 1000;
    const skippedInfo = this.slippageSkippedOrders.get(posKey);
    const refTime = skippedInfo?.skippedAt || leaderPos.updateTime || Date.now();
    const elapsedMs = Date.now() - refTime;

    if (!force && elapsedMs > windowMs) {
      const elapsedMins = Math.round(elapsedMs / 60000);
      throw new Error(`Jendela waktu toleransi ${windowMinutes} menit untuk order susulan ${sym} telah berakhir (${elapsedMins} menit yang lalu). Demi keamanan akun, order dibatalkan.`);
    }

    // 4. Hitung kuantitas target
    const filter = await binanceClient.getSymbolFilter(sym);
    const markPrice = await binanceClient.getSymbolPrice(sym) || leaderPos.markPrice || leaderPos.entryPrice;
    if (markPrice <= 0) {
      throw new Error(`Gagal mendapatkan harga realtime bursa untuk ${sym}.`);
    }

    let targetQty = 0;
    if (this.config.mode === 'FIXED_AMOUNT') {
      targetQty = this.config.fixedAmountUsdt / markPrice;
    } else if (this.config.mode === 'FIXED_RATIO') {
      targetQty = (userBalance * 0.05 * this.config.ratioMultiplier) / markPrice;
    } else {
      // RATIO_EQUITY
      const leaderEquity = this.lastLeaderEquity > 0 ? this.lastLeaderEquity : 50000;
      const equityRatio = (userBalance / leaderEquity) * this.config.ratioMultiplier;
      targetQty = leaderPos.amount * equityRatio;
    }

    // Safety Cap check
    const lev = Math.max(1, leaderPos.leverage || 10);
    const estMargin = (targetQty * markPrice) / lev;
    if (this.config.maxModalPerCoin > 0 && estMargin > this.config.maxModalPerCoin) {
      targetQty = (this.config.maxModalPerCoin * lev) / markPrice;
      this.log('INFO', `🛡️ Safety Cap Aktif: Margin ${sym} dibatasi ke maksimal $${this.config.maxModalPerCoin} USDT`);
    }

    // Normalisasi lot size & min notional Binance ($5 USDT)
    targetQty = binanceClient.roundQuantity(targetQty, filter.stepSize);
    if (targetQty < filter.minQty) targetQty = filter.minQty;
    if (targetQty * markPrice < filter.minNotional) {
      targetQty = binanceClient.roundQuantity(Math.ceil((filter.minNotional * 1.05) / markPrice / filter.stepSize) * filter.stepSize, filter.stepSize);
    }

    if (targetQty <= 0) {
      throw new Error(`Kuantitas order untuk ${sym} bernilai 0 atau tidak memenuhi batas minimum Binance.`);
    }

    // 5. Eksekusi Order
    if (this.config.paperTrading) {
      const newPos: UserPosition = {
        symbol: sym,
        positionSide: targetUserSide,
        positionAmt: targetUserSide === 'LONG' ? targetQty : -targetQty,
        entryPrice: markPrice,
        markPrice: markPrice,
        unRealizedProfit: 0,
        leverage: lev,
        marginType: 'CROSSED',
        notional: targetQty * markPrice,
        margin: (targetQty * markPrice) / lev,
        avgCount: 0,
      };

      this.virtualPositions.set(userPosKey, newPos);
      this.positionAvgCounts.set(posKey, { leader: leaderPos.avgCount || 0, user: 0 });
      this.positionAvgCounts.set(userPosKey, { leader: leaderPos.avgCount || 0, user: 0 });
      this.slippageSkippedOrders.delete(posKey);
      this.slippageSkippedOrders.delete(userPosKey);
      this.saveVirtualState();

      const invTag = isInverse ? ' (🔄 Inversi/Fade)' : '';
      const usedMargin = (targetQty * markPrice) / lev;
      const leaderMargin = (leaderPos && leaderPos.amount > 0 && leaderPos.entryPrice > 0)
        ? (leaderPos.amount * leaderPos.entryPrice) / Math.max(1, leaderPos.leverage || 10)
        : 0;
      this.log('SUCCESS', `🧪 [${isAutoSniper ? 'AUTO-SNIPER' : 'MANUAL RE-ORDER'}${isInverse ? ' INVERSE' : ''} SIMULASI] Berhasil eksekusi order susulan ${sym} ${targetUserSide}${invTag} (${targetQty} koin @ $${markPrice})!`);
      if (!isAutoSniper) {
        this.sendTelegram(
          `⚡ <b>SINKRONISASI ORDER SUSULAN BERHASIL [🧪 SIMULASI${isInverse ? ' 🔄 INVERSE' : ''}]</b>\n\n` +
          `🪙 Simbol: <b>${sym}</b>\n` +
          `📊 Arah Akun: <b>${targetUserSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>${isInverse ? ' <i>(🔄 Inversi Fade Leader)</i>' : ''}\n` +
          `👤 Arah Leader: <b>${positionSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
          `💵 Harga Eksekusi: <b>$${markPrice}</b>\n` +
          `📦 Kuantitas: <b>${targetQty}</b>\n` +
          `⚡ Leverage: <b>${lev}x</b>\n` +
          `💰 Margin Terpakai: <b>$${usedMargin.toFixed(2)} USDT</b>\n` +
          (leaderMargin > 0 ? `👤 Margin Leader: <b>$${leaderMargin.toFixed(2)} USDT</b>\n` : '') +
          `⚡ Mode: <b>Manual Re-Order${isInverse ? ' (Inverse / Fade)' : ''}</b>`
        );
      }

      return {
        success: true,
        message: `✅ Order susulan ${sym} ${targetUserSide}${invTag} (${targetQty} koin @ $${markPrice}) berhasil masuk ke posisi akun Anda!`,
        position: newPos,
        qty: targetQty,
        price: markPrice,
      };
    }

    // Live Binance Futures
    if (!binanceClient.isConfigured()) {
      throw new Error('API Key dan Secret Key Binance belum dikonfigurasi di dashboard.');
    }

    const side: 'BUY' | 'SELL' = targetUserSide === 'LONG' ? 'BUY' : 'SELL';

    try {
      if (this.config.syncLeverage) {
        await binanceClient.setLeverage(sym, lev);
      }
      this.log('INFO', `⚡ [MANUAL RE-ORDER LIVE] Mengirim order susulan ke Binance: ${sym} ${side} ${targetQty} (${targetUserSide})...`);
      const orderRes = await binanceClient.placeMarketOrder(sym, side, targetQty, false, targetUserSide);
      
      this.positionAvgCounts.set(posKey, { leader: leaderPos.avgCount || 0, user: 0 });
      this.positionAvgCounts.set(userPosKey, { leader: leaderPos.avgCount || 0, user: 0 });
      this.slippageSkippedOrders.delete(posKey);
      this.slippageSkippedOrders.delete(userPosKey);
      this.saveVirtualState();

      const invTag = isInverse ? ' [🔄 INVERSE]' : '';
      const usedMargin = (targetQty * markPrice) / lev;
      const leaderMargin = (leaderPos && leaderPos.amount > 0 && leaderPos.entryPrice > 0)
        ? (leaderPos.amount * leaderPos.entryPrice) / Math.max(1, leaderPos.leverage || 10)
        : 0;
      this.log('SUCCESS', `✅ [${isAutoSniper ? 'AUTO-SNIPER' : 'MANUAL RE-ORDER'}${isInverse ? ' INVERSE' : ''} LIVE] Order susulan ${sym} ${side} BERHASIL MASUK ke Binance Futures! Order ID: ${orderRes.orderId}`);
      if (!isAutoSniper) {
        this.sendTelegram(
          `⚡ <b>SINKRONISASI ORDER SUSULAN BERHASIL [🟢 LIVE FUTURES${invTag}]</b>\n\n` +
          `🪙 Simbol: <b>${sym}</b>\n` +
          `📊 Arah Akun: <b>${targetUserSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>${isInverse ? ' <i>(🔄 Inversi Fade Leader)</i>' : ''}\n` +
          `👤 Arah Leader: <b>${positionSide === 'LONG' ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
          `💵 Harga Eksekusi: <b>$${markPrice}</b>\n` +
          `📦 Kuantitas: <b>${targetQty}</b>\n` +
          `⚡ Leverage: <b>${lev}x</b>\n` +
          `💰 Margin Terpakai: <b>$${usedMargin.toFixed(2)} USDT</b>\n` +
          (leaderMargin > 0 ? `👤 Margin Leader: <b>$${leaderMargin.toFixed(2)} USDT</b>\n` : '') +
          `⚡ Order ID: <code>${orderRes.orderId || 'OK'}</code>\n` +
          `💡 Mode: <b>Manual Re-Order${isInverse ? ' (Inverse / Fade)' : ''}</b>`
        );
      }

      return {
        success: true,
        message: `✅ Order susulan real ${sym} ${side} (${targetQty} koin) berhasil masuk ke Binance Futures! Order ID: ${orderRes.orderId}`,
        qty: targetQty,
        price: markPrice,
      };
    } catch (err: any) {
      const errMsg = err.response?.data?.msg || err.message;
      this.log('ERROR', `Gagal eksekusi order susulan di Binance: ${errMsg}`);
      this.sendTelegram(
        `⚠️ <b>ORDER SUSULAN GAGAL DIEKSEKUSI [🟢 LIVE FUTURES]</b>\n\n` +
        `🪙 Simbol: <b>${sym}</b> (${targetUserSide})\n` +
        `⚡ Aksi: Re-Order Susulan (${side} ${targetQty})\n` +
        `❌ Error: <code>${errMsg}</code>\n` +
        `💡 Tips: Periksa saldo margin USDT, leverage, atau batasan akun di Binance Anda.`
      );
      throw new Error(errMsg);
    }
  }
}

export const engine = new CopyTradeEngine();
