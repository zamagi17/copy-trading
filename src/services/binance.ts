import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { BalanceInfo, UserPosition } from '../types';

export interface SymbolFilterInfo {
  stepSize: number;
  minQty: number;
  tickSize: number;
  minNotional: number;
}

export class BinanceFuturesClient {
  private apiKey: string = '';
  private secretKey: string = '';
  private baseUrl: string = 'https://fapi.binance.com';
  private filterCache: Map<string, SymbolFilterInfo> = new Map();
  private lastExchangeInfoFetch: number = 0;
  private timeOffset: number = 0;
  private lastTimeSync: number = 0;
  private lastValidBalance: BalanceInfo | null = null;
  private lastValidPositions: UserPosition[] = [];

  configure(apiKey: string, secretKey: string, isTestnet: boolean = false) {
    this.apiKey = (apiKey || '').trim();
    this.secretKey = (secretKey || '').trim();
    this.baseUrl = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
    this.isDualSidePosition = null;
    this.lastDualSideFetch = 0;
    this.lastTimeSync = 0;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.secretKey);
  }

  /**
   * Sinkronisasi waktu lokal dengan Binance Server Time (/fapi/v1/time)
   * Mencegah error -1021 (Timestamp for this request was 1000ms ahead / outside recvWindow)
   */
  async syncTime(): Promise<number> {
    try {
      const client = axios.create({ baseURL: this.baseUrl, timeout: 5000 });
      const res = await client.get('/fapi/v1/time');
      if (res.data?.serverTime) {
        this.timeOffset = Number(res.data.serverTime) - Date.now();
        this.lastTimeSync = Date.now();
      }
    } catch {}
    return this.timeOffset;
  }

  private getTimestamp(): number {
    return Date.now() + this.timeOffset;
  }

  private sign(queryString: string): string {
    return crypto.createHmac('sha256', this.secretKey).update(queryString).digest('hex');
  }

  private buildSignedQuery(params: Record<string, any> = {}): { query: string; signature: string } {
    const timestamp = this.getTimestamp();
    const parts: string[] = [];
    for (const [key, val] of Object.entries(params)) {
      if (val !== undefined && val !== null && val !== '') {
        parts.push(`${key}=${encodeURIComponent(val)}`);
      }
    }
    parts.push('recvWindow=60000');
    parts.push(`timestamp=${timestamp}`);
    const query = parts.join('&');
    const signature = this.sign(query);
    return { query, signature };
  }

  private createClient(): AxiosInstance {
    return axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
  }

  /**
   * Mengambil saldo akun USDT Binance Futures dengan auto-sync waktu dan caching aman
   */
  async getAccountBalance(): Promise<BalanceInfo> {
    if (!this.isConfigured()) {
      return { totalWalletBalance: 0, totalUnrealizedProfit: 0, totalMarginBalance: 0, availableBalance: 0 };
    }

    if (Date.now() - this.lastTimeSync > 900000) {
      await this.syncTime();
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { query, signature } = this.buildSignedQuery();
        const client = this.createClient();
        const res = await client.get(`/fapi/v2/account?${query}&signature=${signature}`);
        const data = res.data;

        const info: BalanceInfo = {
          totalWalletBalance: Number(data.totalWalletBalance ?? 0),
          totalUnrealizedProfit: Number(data.totalUnrealizedProfit ?? 0),
          totalMarginBalance: Number(data.totalMarginBalance ?? 0),
          availableBalance: Number(data.availableBalance ?? 0),
        };

        if (info.totalWalletBalance > 0 || info.availableBalance > 0 || info.totalMarginBalance > 0) {
          this.lastValidBalance = info;
        }

        return info;
      } catch (err: any) {
        if (err.response?.data?.code === -1021 && attempt === 1) {
          await this.syncTime();
          continue;
        }
        if (attempt === 2) {
          if (this.lastValidBalance) {
            return this.lastValidBalance;
          }
          throw err;
        }
      }
    }

    return this.lastValidBalance || { totalWalletBalance: 0, totalUnrealizedProfit: 0, totalMarginBalance: 0, availableBalance: 0 };
  }

  /**
   * Mengambil posisi aktif yang sedang terbuka di akun pengguna
   */
  async getOpenPositions(): Promise<UserPosition[]> {
    if (!this.isConfigured()) return [];

    if (Date.now() - this.lastTimeSync > 900000) {
      await this.syncTime();
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { query, signature } = this.buildSignedQuery();
        const client = this.createClient();
        const res = await client.get(`/fapi/v2/positionRisk?${query}&signature=${signature}`);
        const list = res.data;

        if (!Array.isArray(list)) return this.lastValidPositions;

        const positions = list
          .filter((p: any) => Math.abs(Number(p.positionAmt || 0)) > 0)
          .map((p: any) => {
            const amt = Number(p.positionAmt || 0);
            let side: 'LONG' | 'SHORT' | 'BOTH' = 'BOTH';
            if (p.positionSide && p.positionSide !== 'BOTH') {
              side = p.positionSide;
            } else {
              side = amt > 0 ? 'LONG' : 'SHORT';
            }

            const entryPrice = Number(p.entryPrice || 0);
            const leverage = Math.max(1, Number(p.leverage || 1));
            const notional = Math.abs(Number(p.notional || 0));
            const computedMargin = (Math.abs(amt) * entryPrice) / leverage;
            const margin = Number(p.initialMargin || p.isolatedMargin || computedMargin || 0);

            return {
              symbol: p.symbol,
              positionSide: side,
              positionAmt: amt,
              entryPrice,
              markPrice: Number(p.markPrice || 0),
              unRealizedProfit: Number(p.unRealizedProfit || 0),
              leverage,
              marginType: p.marginType || 'cross',
              notional,
              margin,
            };
          });

        this.lastValidPositions = positions;
        return positions;
      } catch (err: any) {
        if (err.response?.data?.code === -1021 && attempt === 1) {
          await this.syncTime();
          continue;
        }
        if (attempt === 2) {
          return this.lastValidPositions;
        }
      }
    }

    return this.lastValidPositions;
  }

  /**
   * Cache Exchange Info untuk presisi lot & min notional ($5 USDT)
   */
  async getSymbolFilter(symbol: string): Promise<SymbolFilterInfo> {
    const sym = symbol.toUpperCase();
    if (this.filterCache.has(sym) && Date.now() - this.lastExchangeInfoFetch < 3600000) {
      return this.filterCache.get(sym)!;
    }

    try {
      const client = axios.create({ baseURL: this.baseUrl, timeout: 8000 });
      const res = await client.get('/fapi/v1/exchangeInfo');
      const symbols = res.data.symbols || [];

      for (const s of symbols) {
        let stepSize = 0.001;
        let minQty = 0.001;
        let tickSize = 0.01;
        let minNotional = 5.0;

        for (const f of s.filters || []) {
          if (f.filterType === 'LOT_SIZE') {
            stepSize = parseFloat(f.stepSize) || 0.001;
            minQty = parseFloat(f.minQty) || 0.001;
          } else if (f.filterType === 'PRICE_FILTER') {
            tickSize = parseFloat(f.tickSize) || 0.01;
          } else if (f.filterType === 'MIN_NOTIONAL') {
            minNotional = parseFloat(f.notional) || 5.0;
          }
        }

        this.filterCache.set(s.symbol, { stepSize, minQty, tickSize, minNotional });
      }

      this.lastExchangeInfoFetch = Date.now();
      return this.filterCache.get(sym) || { stepSize: 0.001, minQty: 0.001, tickSize: 0.01, minNotional: 5.0 };
    } catch {
      return this.filterCache.get(sym) || { stepSize: 0.001, minQty: 0.001, tickSize: 0.01, minNotional: 5.0 };
    }
  }

  /**
   * Membulatkan kuantitas sesuai stepSize presisi koin
   */
  roundQuantity(qty: number, stepSize: number): number {
    if (stepSize <= 0 || isNaN(qty) || qty <= 0) return 0;
    const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
    const epsilon = stepSize * 1e-6;
    const rounded = Math.floor((qty + epsilon) / stepSize) * stepSize;
    return parseFloat(rounded.toFixed(precision));
  }

  /**
   * Mengatur leverage koin di Binance Futures
   */
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (!this.isConfigured()) return;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { query, signature } = this.buildSignedQuery({
          symbol: symbol.toUpperCase(),
          leverage,
        });
        const client = this.createClient();
        await client.post(`/fapi/v1/leverage?${query}&signature=${signature}`);
        break;
      } catch (err: any) {
        if (err.response?.data?.code === -1021 && attempt === 1) {
          await this.syncTime();
          continue;
        }
        break;
      }
    }
  }

  /**
   * Mengatur tipe margin (CROSSED / ISOLATED)
   */
  async setMarginType(symbol: string, marginType: 'CROSSED' | 'ISOLATED'): Promise<void> {
    if (!this.isConfigured()) return;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { query, signature } = this.buildSignedQuery({
          symbol: symbol.toUpperCase(),
          marginType,
        });
        const client = this.createClient();
        await client.post(`/fapi/v1/marginType?${query}&signature=${signature}`);
        break;
      } catch (err: any) {
        if (err.response?.data?.code === -1021 && attempt === 1) {
          await this.syncTime();
          continue;
        }
        break;
      }
    }
  }

  private isDualSidePosition: boolean | null = null;
  private lastDualSideFetch: number = 0;

  /**
   * Cek apakah akun pengguna menggunakan Hedge Mode (Dual Side) atau One-Way Mode
   */
  async getDualSidePosition(): Promise<boolean> {
    if (this.isDualSidePosition !== null && Date.now() - this.lastDualSideFetch < 3600000) {
      return this.isDualSidePosition;
    }
    if (!this.isConfigured()) return false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { query, signature } = this.buildSignedQuery();
        const client = this.createClient();
        const res = await client.get(`/fapi/v1/positionSide/dual?${query}&signature=${signature}`);
        this.isDualSidePosition = Boolean(res.data?.dualSidePosition);
        this.lastDualSideFetch = Date.now();
        return this.isDualSidePosition;
      } catch (err: any) {
        if (err.response?.data?.code === -1021 && attempt === 1) {
          await this.syncTime();
          continue;
        }
        return this.isDualSidePosition !== null ? this.isDualSidePosition : false;
      }
    }
    return this.isDualSidePosition !== null ? this.isDualSidePosition : false;
  }

  /**
   * Eksekusi MARKET order (Mendukung One-Way Mode & Hedge Mode)
   */
  async placeMarketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    reduceOnly: boolean = false,
    positionSide?: 'LONG' | 'SHORT' | 'BOTH'
  ): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error('API Key & Secret Key Binance belum dikonfigurasi!');
    }

    const isDual = await this.getDualSidePosition();
    const params: Record<string, any> = {
      symbol: symbol.toUpperCase(),
      side,
      type: 'MARKET',
      quantity,
    };

    if (isDual) {
      params.positionSide = positionSide && positionSide !== 'BOTH' ? positionSide : (side === 'BUY' ? 'LONG' : 'SHORT');
    } else if (reduceOnly) {
      params.reduceOnly = 'true';
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { query, signature } = this.buildSignedQuery(params);
        const client = this.createClient();
        const res = await client.post(`/fapi/v1/order?${query}&signature=${signature}`);
        return res.data;
      } catch (err: any) {
        if (err.response?.data?.code === -1021 && attempt === 1) {
          await this.syncTime();
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Menutup posisi terbuka secara darurat atau sinkronisasi dengan Leader
   * Dilengkapi auto-retry hingga 3x dengan jeda bertahap jika terjadi kedipan jaringan
   */
  async closePosition(symbol: string, currentSide: 'LONG' | 'SHORT', quantity: number, maxRetries: number = 3): Promise<any> {
    const side = currentSide === 'LONG' ? 'SELL' : 'BUY';
    let lastErr: any = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.placeMarketOrder(symbol, side, quantity, true, currentSide);
      } catch (err: any) {
        lastErr = err;
        const msg = String(err.response?.data?.msg || err.message || '');
        // Jika bursa menyatakan posisi sudah 0 atau reduce-only terpenuhi, anggap sukses tertutup
        if (msg.includes('ReduceOnly') || msg.includes('position is zero') || msg.includes('Position does not exist')) {
          return { status: 'ALREADY_CLOSED', msg };
        }
        if (attempt < maxRetries) {
          await new Promise((res) => setTimeout(res, 500 * attempt));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Mengambil harga mark price realtime publik dari Binance Futures
   */
  async getSymbolPrice(symbol: string): Promise<number> {
    try {
      const res = await axios.get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol.toUpperCase()}`, { timeout: 6000 });
      return parseFloat(res.data?.markPrice) || 0;
    } catch {
      return 0;
    }
  }
}

export const binanceClient = new BinanceFuturesClient();
