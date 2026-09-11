import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { LeadPortfolioDetail, LeadPosition, LeadOrderRecord, ProxyConfig } from '../types';

const BASE_URL = 'https://www.binance.com';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Cache IP Cloudflare DoH untuk bypass blokir ISP lokal saat uji coba gratis tanpa proxy
let cachedBinanceIp: string | null = null;
let lastIpResolveTime = 0;

async function resolveBinanceIpViaDoH(): Promise<string | null> {
  if (cachedBinanceIp && Date.now() - lastIpResolveTime < 3600000) {
    return cachedBinanceIp;
  }
  try {
    const res = await axios.get('https://cloudflare-dns.com/dns-query?name=www.binance.com&type=A', {
      headers: { accept: 'application/dns-json' },
      timeout: 5000,
    });
    const answers = res.data?.Answer || [];
    for (const a of answers) {
      if (a.type === 1 && a.data) {
        cachedBinanceIp = a.data;
        lastIpResolveTime = Date.now();
        return a.data;
      }
    }
  } catch {}
  return '18.64.18.113'; // Default fallback cloudfront IP
}

export class CopyTradeScraper {
  private detailCache: Map<string, { data: any; lastFetch: number }> = new Map();

  private async createClient(proxy?: ProxyConfig): Promise<AxiosInstance> {
    const config: AxiosRequestConfig = {
      baseURL: BASE_URL,
      timeout: 10000,
      headers: {
        'User-Agent': CHROME_UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        'clienttype': 'web',
        'Referer': 'https://www.binance.com/en/copy-trading/lead-details/',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    };

    if (proxy && proxy.enabled && proxy.host && proxy.port) {
      // Menggunakan Residential Proxy (DataImpulse, Webshare, dll)
      const auth = proxy.username && proxy.password ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@` : '';
      const proxyUrl = `http://${auth}${proxy.host}:${proxy.port}`;
      const agent = new HttpsProxyAgent(proxyUrl);
      config.httpAgent = agent;
      config.httpsAgent = agent;
      config.proxy = false;
    } else {
      // Uji Coba Gratis / Direct: Gunakan DoH Resolver agar tidak diblokir ISP lokal (TrustPositif)
      const resolvedIp = await resolveBinanceIpViaDoH();
      if (resolvedIp) {
        const agent = new https.Agent({
          lookup: (hostname, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            const opt = typeof options === 'object' ? options : {};
            if (hostname === 'www.binance.com') {
              if (opt && (opt as any).all) {
                cb(null, [{ address: resolvedIp, family: 4 }] as any);
              } else {
                cb(null, resolvedIp, 4);
              }
            } else {
              require('dns').lookup(hostname, options, cb);
            }
          },
        });
        config.httpsAgent = agent;
      }
    }

    return axios.create(config);
  }

  /**
   * Mengambil posisi aktif yang sedang dibuka oleh Leader (jika tidak di-private)
   */
  async fetchPositions(portfolioId: string, proxy?: ProxyConfig): Promise<LeadPosition[]> {
    if (!portfolioId || !portfolioId.trim()) return [];

    try {
      const client = await this.createClient(proxy);
      const url = `/bapi/futures/v1/friendly/future/copy-trade/lead-data/positions?portfolioId=${portfolioId.trim()}`;
      const res = await client.get(url);

      const root = res.data;
      if (!root || (root.code && root.code !== '000000')) {
        return [];
      }

      let dataArr: any[] = [];
      if (Array.isArray(root.data)) {
        dataArr = root.data;
      } else if (root.data && typeof root.data === 'object') {
        dataArr = root.data.list || root.data.positions || [];
      }

      const positions: LeadPosition[] = [];
      for (const item of dataArr) {
        const symbol = String(item.symbol || item.symbolName || '').toUpperCase();
        if (!symbol) continue;

        let amount = Math.abs(Number(item.positionAmount ?? item.amount ?? item.positionAmt ?? 0));
        if (amount === 0) continue;

        let side: 'LONG' | 'SHORT' = 'LONG';
        const rawSide = String(item.positionSide || item.side || '').toUpperCase();
        if (rawSide === 'SHORT' || rawSide === 'SELL') {
          side = 'SHORT';
        } else if (rawSide === 'LONG' || rawSide === 'BUY') {
          side = 'LONG';
        } else {
          const rawAmt = Number(item.positionAmount ?? item.amount ?? 0);
          side = rawAmt < 0 ? 'SHORT' : 'LONG';
        }

        const entryPrice = Number(item.entryPrice ?? item.avgPrice ?? 0);
        const markPrice = Number(item.markPrice ?? 0);
        const unrealizedProfit = Number(item.unrealizedProfit ?? item.pnl ?? 0);
        const leverage = Number(item.leverage ?? 10);
        const marginType: 'CROSSED' | 'ISOLATED' = item.isolated || item.marginType === 'ISOLATED' ? 'ISOLATED' : 'CROSSED';
        const notional = Math.abs(Number(item.notional ?? (amount * (entryPrice > 0 ? entryPrice : markPrice))));

        positions.push({
          symbol,
          positionSide: side,
          amount,
          entryPrice,
          markPrice,
          leverage,
          marginType,
          unrealizedProfit,
          notional,
          updateTime: item.updateTime || Date.now(),
        });
      }

      return positions;
    } catch {
      return [];
    }
  }

  /**
   * Mengambil riwayat order stream terkini (Tab 'Latest Records')
   * Bekerja 100% secara publik bahkan ketika Leader me-private tab Positions!
   */
  async fetchOrderHistory(portfolioId: string, proxy?: ProxyConfig, pageSize: number = 20): Promise<LeadOrderRecord[]> {
    if (!portfolioId || !portfolioId.trim()) return [];

    try {
      const client = await this.createClient(proxy);
      const url = `/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history`;
      const now = Date.now();
      const startTime = now - (7 * 24 * 60 * 60 * 1000); // 7 hari terakhir

      const res = await client.post(url, {
        portfolioId: portfolioId.trim(),
        startTime,
        endTime: now,
        pageSize,
      });

      const root = res.data;
      if (!root || (root.code && root.code !== '000000') || !root.data) {
        return [];
      }

      const list = root.data.list || [];
      const orders: LeadOrderRecord[] = [];

      for (const item of list) {
        const symbol = String(item.symbol || '').toUpperCase();
        if (!symbol) continue;

        const side = String(item.side || 'BUY').toUpperCase() as 'BUY' | 'SELL';
        const positionSide = String(item.positionSide || 'BOTH').toUpperCase() as 'LONG' | 'SHORT';
        const executedQty = Number(item.executedQty ?? item.qty ?? 0);
        const avgPrice = Number(item.avgPrice ?? item.price ?? 0);
        const totalPnl = Number(item.totalPnl ?? 0);
        const orderTime = Number(item.orderTime ?? item.orderUpdateTime ?? Date.now());

        // Tentukan apakah order ini OPEN atau CLOSE
        let action: 'OPEN' | 'CLOSE' = 'OPEN';
        if (positionSide === 'SHORT') {
          action = side === 'SELL' ? 'OPEN' : 'CLOSE';
        } else if (positionSide === 'LONG') {
          action = side === 'BUY' ? 'OPEN' : 'CLOSE';
        }

        orders.push({
          symbol,
          side,
          positionSide,
          action,
          executedQty,
          avgPrice,
          totalPnl,
          orderTime,
        });
      }

      return orders;
    } catch {
      return [];
    }
  }

  /**
   * Mengambil detail portofolio leader (nickname, total margin, ROI, dsb)
   */
  async fetchPortfolioDetail(portfolioId: string, proxy?: ProxyConfig): Promise<LeadPortfolioDetail> {
    const timestamp = Date.now();
    const id = (portfolioId || '').trim();
    if (!id) {
      return {
        portfolioId: '',
        nickname: 'Unknown',
        avatarUrl: '',
        totalEquity: 0,
        roi7d: 0,
        mdd7d: 0,
        followerCount: 0,
        maxFollowerCount: 1000,
        positionShow: false,
        positions: [],
        lastFetchTime: timestamp,
        isSuccess: false,
        errorMessage: 'Portfolio ID kosong',
      };
    }

    try {
      const cached = this.detailCache.get(id);
      let data = cached?.data;

      // Ambil detail portofolio jika belum di-cache atau cache sudah lebih dari 45 detik
      if (!cached || timestamp - cached.lastFetch > 45000) {
        try {
          const client = await this.createClient(proxy);
          const url = `/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${id}`;
          const res = await client.get(url);
          const root = res.data;
          if (root && (root.code === '000000' || !root.code) && root.data) {
            data = root.data;
            this.detailCache.set(id, { data, lastFetch: timestamp });
          }
        } catch {
          // Jika gagal, gunakan data lama yang ada di cache
        }
      }

      const nickname = data?.nickname || data?.leadPortfolioName || `Leader ${id}`;
      const avatarUrl = data?.avatarUrl || '';
      const totalEquity = Number(data?.marginBalance ?? data?.totalEquity ?? data?.leadMargin ?? data?.currentBalance ?? 0);
      const roi7d = Number(data?.roi7d ?? data?.roi ?? 0);
      const mdd7d = Number(data?.mdd7d ?? 0);
      const followerCount = Number(data?.currentCopyCount ?? data?.followerCount ?? 0);
      const maxFollowerCount = Number(data?.maxCopyCount ?? data?.maxFollowerCount ?? 1000);
      const positionShow = data?.positionShow !== false; // false jika di-private oleh leader

      // Ambil posisi aktif jika public
      let positions: LeadPosition[] = [];
      if (positionShow) {
        positions = await this.fetchPositions(id, proxy);
      }

      // Ambil Latest Records (cukup 8 order teratas untuk hemat kuota proxy secara masif)
      const orders = await this.fetchOrderHistory(id, proxy, 8);

      return {
        portfolioId: id,
        nickname,
        avatarUrl,
        totalEquity,
        roi7d,
        mdd7d,
        followerCount,
        maxFollowerCount,
        positionShow,
        positions,
        orders,
        lastFetchTime: timestamp,
        isSuccess: true,
      };
    } catch (err: any) {
      return {
        portfolioId,
        nickname: `Leader ${portfolioId}`,
        avatarUrl: '',
        totalEquity: 0,
        roi7d: 0,
        mdd7d: 0,
        followerCount: 0,
        maxFollowerCount: 1000,
        positionShow: false,
        positions: [],
        lastFetchTime: timestamp,
        isSuccess: false,
        errorMessage: err.message,
      };
    }
  }

  /**
   * Menguji koneksi proxy ke server Binance
   */
  async testProxy(proxy: ProxyConfig): Promise<{ success: boolean; message: string; latencyMs: number }> {
    const start = Date.now();
    try {
      const client = await this.createClient(proxy);
      const res = await client.get('/bapi/futures/v1/public/future/common/time');
      const latencyMs = Date.now() - start;
      return { success: true, message: 'Koneksi ke Binance berhasil!', latencyMs };
    } catch (err: any) {
      return { success: false, message: err.message || 'Koneksi gagal', latencyMs: Date.now() - start };
    }
  }
}

export const scraper = new CopyTradeScraper();
