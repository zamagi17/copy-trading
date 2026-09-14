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

  configure(apiKey: string, secretKey: string, isTestnet: boolean = false) {
    this.apiKey = (apiKey || '').trim();
    this.secretKey = (secretKey || '').trim();
    this.baseUrl = isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.secretKey);
  }

  private sign(queryString: string): string {
    return crypto.createHmac('sha256', this.secretKey).update(queryString).digest('hex');
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
   * Mengambil saldo akun USDT Binance Futures
   */
  async getAccountBalance(): Promise<BalanceInfo> {
    if (!this.isConfigured()) {
      return { totalWalletBalance: 0, totalUnrealizedProfit: 0, totalMarginBalance: 0, availableBalance: 0 };
    }

    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = this.sign(query);

    const client = this.createClient();
    const res = await client.get(`/fapi/v2/account?${query}&signature=${signature}`);
    const data = res.data;

    return {
      totalWalletBalance: Number(data.totalWalletBalance ?? 0),
      totalUnrealizedProfit: Number(data.totalUnrealizedProfit ?? 0),
      totalMarginBalance: Number(data.totalMarginBalance ?? 0),
      availableBalance: Number(data.availableBalance ?? 0),
    };
  }

  /**
   * Mengambil posisi aktif yang sedang terbuka di akun pengguna
   */
  async getOpenPositions(): Promise<UserPosition[]> {
    if (!this.isConfigured()) return [];

    const timestamp = Date.now();
    const query = `timestamp=${timestamp}`;
    const signature = this.sign(query);

    const client = this.createClient();
    const res = await client.get(`/fapi/v2/positionRisk?${query}&signature=${signature}`);
    const list = res.data;

    if (!Array.isArray(list)) return [];

    return list
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
    if (stepSize <= 0) return qty;
    const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
    const rounded = Math.floor(qty / stepSize) * stepSize;
    return parseFloat(rounded.toFixed(precision));
  }

  /**
   * Mengatur leverage koin di Binance Futures
   */
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      const timestamp = Date.now();
      const query = `symbol=${symbol.toUpperCase()}&leverage=${leverage}&timestamp=${timestamp}`;
      const signature = this.sign(query);
      const client = this.createClient();
      await client.post(`/fapi/v1/leverage?${query}&signature=${signature}`);
    } catch (err: any) {
      // Abaikan error jika leverage sudah sama
    }
  }

  /**
   * Mengatur tipe margin (CROSSED / ISOLATED)
   */
  async setMarginType(symbol: string, marginType: 'CROSSED' | 'ISOLATED'): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      const timestamp = Date.now();
      const query = `symbol=${symbol.toUpperCase()}&marginType=${marginType}&timestamp=${timestamp}`;
      const signature = this.sign(query);
      const client = this.createClient();
      await client.post(`/fapi/v1/marginType?${query}&signature=${signature}`);
    } catch {
      // Abaikan jika tipe margin sudah sama (biasanya error -4046 No need to change)
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
    try {
      const timestamp = Date.now();
      const query = `timestamp=${timestamp}`;
      const signature = this.sign(query);
      const client = this.createClient();
      const res = await client.get(`/fapi/v1/positionSide/dual?${query}&signature=${signature}`);
      this.isDualSidePosition = Boolean(res.data?.dualSidePosition);
      this.lastDualSideFetch = Date.now();
      return this.isDualSidePosition;
    } catch {
      return false;
    }
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
    const timestamp = Date.now();
    let query = `symbol=${symbol.toUpperCase()}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;

    if (isDual) {
      // Hedge Mode: positionSide wajib dispesifikasikan (LONG/SHORT), reduceOnly tidak dipakai
      const pSide = positionSide && positionSide !== 'BOTH' ? positionSide : (side === 'BUY' ? 'LONG' : 'SHORT');
      query += `&positionSide=${pSide}`;
    } else {
      // One-Way Mode (persis seperti bot trading-ai): gunakan reduceOnly saat menutup posisi
      if (reduceOnly) {
        query += `&reduceOnly=true`;
      }
    }

    const signature = this.sign(query);
    const client = this.createClient();
    const res = await client.post(`/fapi/v1/order?${query}&signature=${signature}`);
    return res.data;
  }

  /**
   * Menutup posisi terbuka secara darurat atau sinkronisasi dengan Leader
   */
  async closePosition(symbol: string, currentSide: 'LONG' | 'SHORT', quantity: number): Promise<any> {
    const side = currentSide === 'LONG' ? 'SELL' : 'BUY';
    return this.placeMarketOrder(symbol, side, quantity, true, currentSide);
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
