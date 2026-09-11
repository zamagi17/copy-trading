import fs from 'fs';
import path from 'path';
import { AppConfig, EngineStatus, LeadPosition, LogEntry, UserPosition } from '../types';
import { binanceClient } from './binance';
import { scraper } from './scraper';

const CONFIG_PATH = path.resolve(__dirname, '../../config.json');

export class CopyTradeEngine {
  private config: AppConfig;
  private isRunning: boolean = false;
  private pollTimeout: NodeJS.Timeout | null = null;
  private lastLeaderPositions: Map<string, LeadPosition> = new Map();
  private lastLeaderEquity: number = 0;
  private logs: LogEntry[] = [];
  private pollCount: number = 0;
  private lastError: string | null = null;
  private lastProcessedOrderTime: number = 0;
  public virtualPositions: Map<string, UserPosition> = new Map();
  public virtualWalletBalance: number = 100;
  private wsBroadcaster: ((type: string, payload: any) => void) | null = null;

  constructor() {
    this.config = this.loadConfig();
    this.virtualWalletBalance = this.config.virtualBalanceUsdt ?? 100;
    this.initBinance();
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
      maxModalPerCoin: 50.0,
      maxSlippagePct: 0.5,
      syncLeverage: true,
      emergencySlPct: 10.0,
      pollingIntervalMs: 2500,
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
    this.config = { ...this.config, ...newConfig };
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
      this.initBinance();
      this.log('INFO', 'Pengaturan berhasil disimpan ke config.json');
    } catch (e: any) {
      this.log('ERROR', `Gagal menyimpan config.json: ${e.message}`);
    }
    return this.config;
  }

  getConfig(): AppConfig {
    return this.config;
  }

  private initBinance() {
    binanceClient.configure(this.config.binanceApiKey, this.config.binanceSecretKey, this.config.isTestnet);
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
    this.virtualWalletBalance = this.config.virtualBalanceUsdt ?? 100;
    this.logs = [];
    this.lastProcessedOrderTime = 0;
    this.log('INFO', '🧹 Riwayat demo & posisi virtual telah di-reset bersih.');
  }

  getStatus(): EngineStatus {
    const userPositions = this.config.paperTrading
      ? Array.from(this.virtualPositions.values())
      : [];
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
    };
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastProcessedOrderTime = 0;
    this.config.copyTradeActive = true;
    this.saveConfig({ copyTradeActive: true });
    const modeTag = this.config.paperTrading ? '🧪 [MODE SIMULASI / PAPER TRADE]' : '🟢 [LIVE TRADING]';
    this.log('SUCCESS', `🚀 Copy Trade Engine DIAKTIFKAN (${modeTag}) untuk Leader Portfolio: ${this.config.portfolioId}`);
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
    const baseInterval = this.config.pollingIntervalMs || 1500;
    const jitter = Math.floor(Math.random() * (baseInterval * 0.2)) - Math.floor(baseInterval * 0.1);
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
      this.log('WARN', `Gagal fetch data leader: ${leaderDetail.errorMessage}`);
      return;
    }

    this.lastLeaderEquity = leaderDetail.totalEquity || this.lastLeaderEquity;
    const currentLeaderPositions = leaderDetail.positions || [];

    // Map untuk posisi leader saat ini
    const currentLeaderMap = new Map<string, LeadPosition>();
    for (const p of currentLeaderPositions) {
      const key = `${p.symbol}_${p.positionSide}`;
      currentLeaderMap.set(key, p);
    }

    // 2. Fetch saldo dan posisi akun pengguna (atau virtual jika mode simulasi)
    let userBalance = 0;
    let userPositions: UserPosition[] = [];

    if (this.config.paperTrading) {
      userBalance = this.virtualWalletBalance;
      // Sinkronkan mark price & hitung floating PnL untuk posisi simulasi
      for (const [k, vp] of this.virtualPositions.entries()) {
        const lp = currentLeaderMap.get(k);
        if (lp && lp.markPrice > 0) {
          vp.markPrice = lp.markPrice;
          const qty = Math.abs(vp.positionAmt);
          vp.unRealizedProfit = vp.positionSide === 'LONG'
            ? (vp.markPrice - vp.entryPrice) * qty
            : (vp.entryPrice - vp.markPrice) * qty;
        }
      }
      userPositions = Array.from(this.virtualPositions.values());
    } else if (binanceClient.isConfigured()) {
      try {
        const bal = await binanceClient.getAccountBalance();
        userBalance = bal.totalWalletBalance > 0 ? bal.totalWalletBalance : bal.availableBalance;
        userPositions = await binanceClient.getOpenPositions();
      } catch (e: any) {
        this.log('WARN', `Gagal ambil saldo/posisi akun pengguna: ${e.message}`);
      }
    }

    const userPositionsMap = new Map<string, UserPosition>();
    for (const up of userPositions) {
      const key = `${up.symbol}_${up.positionSide}`;
      userPositionsMap.set(key, up);
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
              };
              await this.handleNewPosition(mockPos, userBalance, userPositionsMap.get(`${ord.symbol}_${ord.positionSide}`));
            } else if (ord.action === 'CLOSE') {
              this.log('INFO', `🎯 [Latest Records] Leader MENUTUP ${ord.positionSide} ${ord.symbol} @ $${ord.avgPrice}`);
              const key = `${ord.symbol}_${ord.positionSide}`;
              const userPos = userPositionsMap.get(key);
              if (userPos && Math.abs(userPos.positionAmt) > 0) {
                if (this.config.paperTrading) {
                  const qty = Math.abs(userPos.positionAmt);
                  const pnl = ord.positionSide === 'LONG'
                    ? (ord.avgPrice - userPos.entryPrice) * qty
                    : (userPos.entryPrice - ord.avgPrice) * qty;
                  this.virtualWalletBalance += pnl;
                  this.virtualPositions.delete(key);
                  this.log('SUCCESS', `🧪 [MODE SIMULASI] Posisi ${ord.symbol} ${ord.positionSide} ditutup sinkron! PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDT (Saldo virtual: $${this.virtualWalletBalance.toFixed(2)} USDT)`);
                } else {
                  await binanceClient.closePosition(ord.symbol, ord.positionSide, Math.abs(userPos.positionAmt));
                  this.log('SUCCESS', `✅ Posisi ${ord.symbol} ${ord.positionSide} akun Anda berhasil ditutup sinkron.`);
                }
              }
            }
          }
        }
      }
    } else {
      // =========================================================================
      // MODE PUBLIC POSITIONS: Leader membuka tab Positions untuk publik.
      // Bot menggunakan Delta State Machine presisi tinggi.
      // =========================================================================
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

    // 5. Emergency Stop Loss Check
    if (this.config.emergencySlPct > 0 && userBalance > 0) {
      for (const up of userPositions) {
        if (up.unRealizedProfit < 0) {
          const lossPct = (Math.abs(up.unRealizedProfit) / userBalance) * 100;
          if (lossPct >= this.config.emergencySlPct) {
            this.log('ERROR', `🚨 EMERGENCY STOP LOSS DIPICU! ${up.symbol} floating loss: -${lossPct.toFixed(2)}% (Batas: ${this.config.emergencySlPct}%). Menutup posisi darurat!`);
            const side: 'LONG' | 'SHORT' = up.positionAmt > 0 ? 'LONG' : 'SHORT';
            try {
              await binanceClient.closePosition(up.symbol, side, Math.abs(up.positionAmt));
              this.log('SUCCESS', `✅ Berhasil menutup darurat ${up.symbol}`);
            } catch (e: any) {
              this.log('ERROR', `Gagal menutup darurat ${up.symbol}: ${e.message}`);
            }
          }
        }
      }
    }

    // Update snapshot posisi leader
    this.lastLeaderPositions = currentLeaderMap;

    // Broadcast update ke UI dashboard via WebSocket
    if (this.wsBroadcaster) {
      this.wsBroadcaster('TICK', {
        status: this.getStatus(),
        leader: {
          nickname: leaderDetail.nickname,
          totalEquity: leaderDetail.totalEquity,
          roi7d: leaderDetail.roi7d,
          mdd7d: leaderDetail.mdd7d,
          positions: currentLeaderPositions,
        },
        user: {
          balance: userBalance,
          positions: userPositions,
        },
      });
    }
  }

  private async handleNewPosition(leaderPos: LeadPosition, userBalance: number, existingUserPos?: UserPosition) {
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

    // Terapkan Safety Cap (Maksimal modal per koin)
    const notional = targetQty * markPrice;
    if (this.config.maxModalPerCoin > 0 && notional > this.config.maxModalPerCoin) {
      targetQty = this.config.maxModalPerCoin / markPrice;
      this.log('INFO', `🛡️ Safety Cap Aktif: Volume ${leaderPos.symbol} dibatasi ke nominal maksimal $${this.config.maxModalPerCoin} USDT`);
    }

    // Normalisasi presisi lot
    targetQty = binanceClient.roundQuantity(targetQty, filter.stepSize);

    // Validasi minimal notional ($5 USDT) dan minimal kuantitas
    if (targetQty < filter.minQty || targetQty * markPrice < filter.minNotional) {
      this.log('WARN', `Kuantitas order ${leaderPos.symbol} (${targetQty}) di bawah batas minimum Binance ($${filter.minNotional} USDT / ${filter.minQty}). Order dibatalkan.`);
      return;
    }

    const side: 'BUY' | 'SELL' = leaderPos.positionSide === 'LONG' ? 'BUY' : 'SELL';

    // JIKA MODE SIMULASI (PAPER TRADING) AKTIF: Eksekusi secara virtual tanpa API Key & tanpa modal riil
    if (this.config.paperTrading) {
      const posKey = `${leaderPos.symbol}_${leaderPos.positionSide}`;
      const virtualPos: UserPosition = {
        symbol: leaderPos.symbol,
        positionSide: leaderPos.positionSide,
        positionAmt: leaderPos.positionSide === 'LONG' ? targetQty : -targetQty,
        entryPrice: markPrice,
        markPrice: markPrice,
        unRealizedProfit: 0,
        leverage: leaderPos.leverage || 10,
        marginType: leaderPos.marginType || 'CROSSED',
        notional: targetQty * markPrice,
      };
      this.virtualPositions.set(posKey, virtualPos);
      const estMargin = (targetQty * markPrice) / (leaderPos.leverage || 10);
      this.log('SUCCESS', `🧪 [MODE SIMULASI] Order virtual BERHASIL DIBUKA: ${side} ${targetQty} ${leaderPos.symbol} @ $${markPrice} (Estimasi Margin: $${estMargin.toFixed(2)} USDT, Leverage: ${leaderPos.leverage || 10}x)`);
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

    // Safety Cap check
    const currentNotional = (userCurrentQty + addQty) * markPrice;
    if (this.config.maxModalPerCoin > 0 && currentNotional > this.config.maxModalPerCoin) {
      addQty = Math.max(0, (this.config.maxModalPerCoin - userCurrentQty * markPrice) / markPrice);
      if (addQty <= 0) {
        this.log('WARN', `🛡️ Safety Cap Tercapai untuk ${leaderPos.symbol}. Tidak menambah posisi lagi.`);
        return;
      }
    }

    addQty = binanceClient.roundQuantity(addQty, filter.stepSize);
    if (addQty < filter.minQty || addQty * markPrice < filter.minNotional) {
      return;
    }

    if (this.config.paperTrading) {
      const posKey = `${leaderPos.symbol}_${leaderPos.positionSide}`;
      const oldQty = Math.abs(existingUserPos.positionAmt);
      const newQty = oldQty + addQty;
      const newEntry = (oldQty * existingUserPos.entryPrice + addQty * markPrice) / newQty;
      existingUserPos.positionAmt = leaderPos.positionSide === 'LONG' ? newQty : -newQty;
      existingUserPos.entryPrice = newEntry;
      existingUserPos.notional = newQty * markPrice;
      this.virtualPositions.set(posKey, existingUserPos);
      this.log('SUCCESS', `🧪 [MODE SIMULASI] Virtual Averaging Berhasil: ${leaderPos.symbol} (+${addQty}, total: ${newQty.toFixed(4)} @ $${newEntry.toFixed(2)})`);
      return;
    }

    try {
      const side: 'BUY' | 'SELL' = leaderPos.positionSide === 'LONG' ? 'BUY' : 'SELL';
      this.log('INFO', `➕ Menambah posisi ${leaderPos.symbol} sebanyak ${addQty}...`);
      await binanceClient.placeMarketOrder(leaderPos.symbol, side, addQty, false);
      this.log('SUCCESS', `✅ Berhasil menambah posisi ${leaderPos.symbol} (+${addQty})`);
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

    if (this.config.paperTrading) {
      const posKey = `${leaderPos.symbol}_${existingUserPos.positionSide}`;
      const oldQty = Math.abs(existingUserPos.positionAmt);
      const newQty = Math.max(0, oldQty - closeQty);
      const markPrice = leaderPos.markPrice > 0 ? leaderPos.markPrice : leaderPos.entryPrice;
      const pnl = existingUserPos.positionSide === 'LONG'
        ? (markPrice - existingUserPos.entryPrice) * closeQty
        : (existingUserPos.entryPrice - markPrice) * closeQty;
      this.virtualWalletBalance += pnl;
      if (newQty <= 0) {
        this.virtualPositions.delete(posKey);
      } else {
        existingUserPos.positionAmt = existingUserPos.positionSide === 'LONG' ? newQty : -newQty;
        this.virtualPositions.set(posKey, existingUserPos);
      }
      this.log('SUCCESS', `🧪 [MODE SIMULASI] Virtual Partial Close: ${leaderPos.symbol} (-${closeQty}). PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDT (Saldo virtual: $${this.virtualWalletBalance.toFixed(2)} USDT)`);
      return;
    }

    try {
      const side: 'LONG' | 'SHORT' = existingUserPos.positionAmt > 0 ? 'LONG' : 'SHORT';
      this.log('INFO', `✂️ Menutup parsial ${leaderPos.symbol} (${(closeRatio * 100).toFixed(1)}%, Vol: ${closeQty})...`);
      await binanceClient.closePosition(leaderPos.symbol, side, closeQty);
      this.log('SUCCESS', `✅ Sukses partial close ${leaderPos.symbol} (${closeQty})`);
    } catch (e: any) {
      this.log('ERROR', `Gagal partial close ${leaderPos.symbol}: ${e.response?.data?.msg || e.message}`);
    }
  }

  private async handleFullClose(leaderPos: LeadPosition, existingUserPos: UserPosition) {
    const qty = Math.abs(existingUserPos.positionAmt);
    const side: 'LONG' | 'SHORT' = existingUserPos.positionAmt > 0 ? 'LONG' : 'SHORT';
    const markPrice = leaderPos.markPrice > 0 ? leaderPos.markPrice : leaderPos.entryPrice;

    if (this.config.paperTrading) {
      const posKey = `${existingUserPos.symbol}_${side}`;
      const pnl = side === 'LONG'
        ? (markPrice - existingUserPos.entryPrice) * qty
        : (existingUserPos.entryPrice - markPrice) * qty;
      this.virtualWalletBalance += pnl;
      this.virtualPositions.delete(posKey);
      this.log('SUCCESS', `🧪 [MODE SIMULASI] Virtual Posisi ${existingUserPos.symbol} ${side} DITUTUP LENGKAP! PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDT. Saldo simulasi: $${this.virtualWalletBalance.toFixed(2)} USDT`);
      return;
    }

    try {
      this.log('INFO', `🚪 Mengirim order Market Close untuk ${existingUserPos.symbol} (Qty: ${qty})...`);
      await binanceClient.closePosition(existingUserPos.symbol, side, qty);
      this.log('SUCCESS', `✅ Posisi ${existingUserPos.symbol} ${side} BERHASIL DITUTUP SEMPURNA!`);
    } catch (e: any) {
      this.log('ERROR', `Gagal menutup posisi ${existingUserPos.symbol}: ${e.response?.data?.msg || e.message}`);
    }
  }

  async panicCloseAll(): Promise<string> {
    this.log('WARN', '🚨 TOMBOL PANIC CLOSE DITEKAN! Menutup semua posisi copy-trade aktif...');
    if (this.config.paperTrading) {
      const count = this.virtualPositions.size;
      this.virtualPositions.clear();
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
        await binanceClient.closePosition(p.symbol, side, Math.abs(p.positionAmt));
        count++;
      }

      this.log('SUCCESS', `✅ Berhasil menutup ${count} posisi terbuka secara darurat!`);
      return `Berhasil menutup ${count} posisi terbuka.`;
    } catch (e: any) {
      this.log('ERROR', `Gagal melakukan panic close: ${e.message}`);
      throw e;
    }
  }
}

export const engine = new CopyTradeEngine();
