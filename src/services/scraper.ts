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
  private detailCache: Map<string, { data: any; perf?: any; lastFetch: number }> = new Map();
  private cachedClient: AxiosInstance | null = null;
  private cachedClientKey: string = '';
  private cachedAgent: any = null;
  private lastRequestTime: number = 0;

  public resetClient() {
    if (this.cachedAgent && typeof this.cachedAgent.destroy === 'function') {
      try {
        this.cachedAgent.destroy();
      } catch {}
    }
    this.cachedAgent = null;
    this.cachedClient = null;
    this.cachedClientKey = '';
  }

  private async createClient(proxy?: ProxyConfig): Promise<AxiosInstance> {
    let proxyHost = (proxy?.host || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    let proxyPort = proxy?.port;
    if (proxyHost.includes(':')) {
      const parts = proxyHost.split(':');
      proxyHost = parts[0];
      if (!proxyPort && parts[1]) {
        proxyPort = parseInt(parts[1]) || null;
      }
    }

    const isProxyActive = Boolean(proxy && proxy.enabled && proxyHost && proxyPort);
    const clientKey = isProxyActive 
      ? `proxy_${proxy?.username || ''}_${proxyHost}_${proxyPort}` 
      : 'direct_doh';

    // Jika jeda antar request > 20 detik (seperti mode standby libur 60s/120s),
    // remote proxy/Cloudflare sudah memutus idle TCP connection (biasanya timeout 30-45s).
    // Reset client agar tidak mencoba memakai socket basi yang memicu 'socket hang up'!
    if (Date.now() - this.lastRequestTime > 20000) {
      this.resetClient();
    }
    this.lastRequestTime = Date.now();

    // REUSE existing persistent client & Keep-Alive socket HANYA jika request cepat (< 20 detik)
    // Mencegah pembuatan TLS Handshake baru di setiap request (menghemat ~70% kuota proxy!)
    if (this.cachedClient && this.cachedClientKey === clientKey) {
      return this.cachedClient;
    }

    const config: AxiosRequestConfig = {
      baseURL: BASE_URL,
      timeout: isProxyActive ? 15000 : 10000,
      headers: {
        'User-Agent': CHROME_UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'clienttype': 'web',
        'Connection': 'keep-alive',
      },
      decompress: true,
    };

    if (isProxyActive) {
      // Menggunakan Residential Proxy dengan persistent Keep-Alive socket
      const auth = proxy!.username && proxy!.password ? `${encodeURIComponent(proxy!.username)}:${encodeURIComponent(proxy!.password)}@` : '';
      const proxyUrl = `http://${auth}${proxyHost}:${proxyPort}`;
      const agent = new HttpsProxyAgent(proxyUrl, {
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 5,
        maxFreeSockets: 2,
        timeout: 60000,
        rejectUnauthorized: false, // Mencegah 'unable to get local issuer certificate' pada proxy residential
      });
      config.httpAgent = agent;
      config.httpsAgent = agent;
      config.proxy = false;
      this.cachedAgent = agent;
    } else {
      // Uji Coba Gratis / Direct: Gunakan DoH Resolver agar tidak diblokir ISP lokal (TrustPositif)
      const resolvedIp = await resolveBinanceIpViaDoH();
      if (resolvedIp) {
        const agent = new https.Agent({
          keepAlive: true,
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
        this.cachedAgent = agent;
      }
    }

    this.cachedClient = axios.create(config);
    this.cachedClientKey = clientKey;
    return this.cachedClient;
  }

  /**
   * Mengambil posisi aktif yang sedang dibuka oleh Leader (jika tidak di-private)
   */
  async fetchPositions(portfolioId: string, proxy?: ProxyConfig): Promise<LeadPosition[]> {
    if (!portfolioId || !portfolioId.trim()) return [];

    try {
      const client = await this.createClient(proxy);
      const url = `/bapi/futures/v1/friendly/future/copy-trade/lead-data/positions?portfolioId=${portfolioId.trim()}&_t=${Date.now()}`;
      const res = await client.get(url, {
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
        },
      });

      const root = res.data;
      if (!root || (root.code && root.code !== '000000')) {
        throw new Error(`Binance API error: code ${root?.code || 'EMPTY_RESPONSE'}`);
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
        const markPrice = Number(item.markPrice ?? item.mark_price ?? item.lastPrice ?? 0);
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
    } catch (err: any) {
      throw err;
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
      const startTime = now - (12 * 60 * 60 * 1000); // Cukup 12 jam terakhir (menghemat bandwidth)

      const res = await client.post(url, {
        portfolioId: portfolioId.trim(),
        startTime,
        endTime: now,
        pageSize,
      }, {
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
        },
      });

      const root = res.data;
      if (!root || (root.code && root.code !== '000000') || !root.data) {
        throw new Error(`Binance API order-history error: code ${root?.code || 'EMPTY_RESPONSE'}`);
      }

      const list = root.data.list || [];
      const orders: LeadOrderRecord[] = [];

      for (const item of list) {
        const symbol = String(item.symbol || '').toUpperCase();
        if (!symbol) continue;

        const side = String(item.side || 'BUY').toUpperCase() as 'BUY' | 'SELL';
        const rawPosSide = String(item.positionSide || 'BOTH').toUpperCase();
        const executedQty = Number(item.executedQty ?? item.qty ?? 0);
        const avgPrice = Number(item.avgPrice ?? item.price ?? 0);
        if (executedQty <= 0 || avgPrice <= 0) continue;
        const totalPnl = Number(item.totalPnl ?? item.realizedPnl ?? 0);
        // BEST PRACTICE: Prioritaskan orderUpdateTime (waktu order match / fill di bursa)
        // sebagai patokan utama eksekusi copy trade agar limit order yang baru match tidak terlewat.
        const orderTime = Number(item.orderUpdateTime ?? item.orderTime ?? Date.now());
        const orderCreationTime = Number(item.orderTime ?? item.orderUpdateTime ?? Date.now());

        // Tentukan apakah order ini OPEN atau CLOSE serta normalisasikan positionSide ke LONG / SHORT
        let positionSide: 'LONG' | 'SHORT' = 'LONG';
        let action: 'OPEN' | 'CLOSE' = 'OPEN';

        if (rawPosSide === 'SHORT') {
          positionSide = 'SHORT';
          action = side === 'SELL' ? 'OPEN' : 'CLOSE';
        } else if (rawPosSide === 'LONG') {
          positionSide = 'LONG';
          action = side === 'BUY' ? 'OPEN' : 'CLOSE';
        } else {
          // Mode One-Way (positionSide bernilai 'BOTH' atau tidak didefinisikan)
          const hasRealizedPnl = Math.abs(totalPnl) > 0.0001;
          if (hasRealizedPnl) {
            action = 'CLOSE';
            // Pada One-Way mode: order SELL yang menghasilkan Realized PnL menutup posisi LONG, order BUY menutup posisi SHORT
            positionSide = side === 'SELL' ? 'LONG' : 'SHORT';
          } else {
            action = 'OPEN';
            positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
          }
        }

        // Signature unik untuk mencegah dobel eksekusi dan menjamin idempotensi
        const orderKey = `${symbol}_${side}_${positionSide}_${action}_${executedQty}_${avgPrice}_${orderCreationTime}_${orderTime}`;

        orders.push({
          symbol,
          side,
          positionSide,
          action,
          executedQty,
          avgPrice,
          totalPnl,
          orderTime,
          orderCreationTime,
          orderKey,
        });
      }

      return orders;
    } catch (err: any) {
      throw err;
    }
  }

  /**
   * Mengambil detail portofolio leader (nickname, total margin, ROI, dsb)
   * Dilengkapi auto-retry 1x instan pada transient glitch agar tidak memicu log error palsu.
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

    let lastError: any = null;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this._doFetchPortfolioDetail(id, proxy, timestamp);
      } catch (err: any) {
        lastError = err;
        this.resetClient();

        // Jangan retry jika error fatal seperti IP Blocked (403) atau Kuota Habis (407)
        const isFatal = err.response?.status === 403 || err.response?.status === 407 ||
          err.message?.includes('403') || err.message?.includes('407');
        if (isFatal || attempt >= maxAttempts) {
          break;
        }

        // Tunggu sejenak (800ms) sebelum mencoba lagi dengan socket connection fresh
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    return this._handleFetchError(id, lastError, timestamp);
  }

  private async _doFetchPortfolioDetail(id: string, proxy?: ProxyConfig, timestamp: number = Date.now()): Promise<LeadPortfolioDetail> {
    const cached = this.detailCache.get(id);
    let data = cached?.data;
    let perf = cached?.perf;

    // Ambil detail portofolio & performa (ROI/MDD) jika belum di-cache atau cache sudah lebih dari 5 menit (300 detik)
    if (!cached || timestamp - cached.lastFetch > 300000) {
      try {
        const client = await this.createClient(proxy);
        const [detailRes, perfRes] = await Promise.allSettled([
          client.get(`/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${id}`),
          client.get(`/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance?portfolioId=${id}&timeRange=7D`)
        ]);

        if (detailRes.status === 'fulfilled' && detailRes.value.data?.data) {
          data = detailRes.value.data.data;
        }
        if (perfRes.status === 'fulfilled' && perfRes.value.data?.data) {
          perf = perfRes.value.data.data;
        }

        if (data || perf) {
          this.detailCache.set(id, { data, perf, lastFetch: timestamp });
        }
      } catch {
        // Jika gagal, gunakan data lama yang ada di cache
      }
    }

    if (!data) {
      throw new Error(`Gagal mengambil data detail portofolio leader ${id} dari Binance.`);
    }

    const nickname = data?.nickname || data?.leadPortfolioName || `Leader ${id}`;
    const avatarUrl = data?.avatarUrl || '';
    const totalEquity = Number(data?.marginBalance ?? data?.totalEquity ?? data?.leadMargin ?? data?.currentBalance ?? 0);
    const roi7d = Number(perf?.roi ?? data?.roi7d ?? data?.roi ?? 0);
    const mdd7d = Number(perf?.mdd ?? data?.mdd7d ?? 0);
    const winRate = Number(perf?.winRate ?? 0);
    const copierPnl = Number(perf?.copierPnl ?? data?.copierPnl ?? 0);
    const followerCount = Number(data?.currentCopyCount ?? data?.followerCount ?? 0);
    const maxFollowerCount = Number(data?.maxCopyCount ?? data?.maxFollowerCount ?? 1000);
    const positionShow = data?.positionShow !== false; // false jika di-private oleh leader

    // Ambil posisi aktif jika public, atau ambil Latest Records HANYA jika mode privat
    // Tidak mengambil keduanya sekaligus agar kuota proxy hemat hingga 50%!
    let positions: LeadPosition[] = [];
    let orders: LeadOrderRecord[] = [];

    if (positionShow) {
      // Mode Publik: Hanya ambil posisi aktif yang sedang terbuka
      positions = await this.fetchPositions(id, proxy);
    } else {
      // Mode Privat: Ambil 10 order teratas agar dapat merekonstruksi posisi aktif secara akurat
      orders = await this.fetchOrderHistory(id, proxy, 10);
    }

    return {
      portfolioId: id,
      nickname,
      avatarUrl,
      totalEquity,
      roi7d,
      mdd7d,
      winRate,
      copierPnl,
      followerCount,
      maxFollowerCount,
      positionShow,
      positions,
      orders,
      lastFetchTime: timestamp,
      isSuccess: true,
    };
  }

  private _handleFetchError(portfolioId: string, err: any, timestamp: number): LeadPortfolioDetail {
    this.resetClient();
    let errorMsg = err?.message || 'Gagal mengambil data leader';
    const msg = String(err?.message || '');
    const code = String(err?.code || '');
    const status = err?.response?.status;

    if (status === 403 || msg.includes('403')) {
      errorMsg = 'IP_BLOCKED_403: Akses DITOLAK oleh Cloudflare / Binance (HTTP 403 Forbidden). IP Proxy Anda terdeteksi atau terblokir.';
    } else if (status === 407 || msg.includes('407')) {
      errorMsg = 'PROXY_AUTH_407: Autentikasi Proxy Gagal atau Kuota Habis (HTTP 407). Periksa saldo/kuota proxy Anda.';
    } else if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
      errorMsg = 'PROXY_REFUSED: Koneksi ke server proxy ditolak (Connection Refused). Periksa Host dan Port proxy.';
    } else if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || msg.includes('timeout')) {
      errorMsg = 'PROXY_TIMEOUT: Koneksi ke proxy timeout (>15 detik).';
    } else if (code === 'ENOTFOUND' || msg.includes('ENOTFOUND')) {
      errorMsg = 'PROXY_DNS_FAILED: Host proxy tidak ditemukan (DNS lookup failed).';
    } else if (
      msg.includes('EPROTO') ||
      msg.includes('wrong version number') ||
      msg.includes('SSL routines') ||
      msg.includes('certificate') ||
      msg.includes('local issuer')
    ) {
      errorMsg = 'PROXY_SSL_GLITCH: Terjadi gangguan handshake SSL pada node proxy residential.';
    } else if (msg.includes('socket hang up') || code === 'ECONNRESET') {
      errorMsg = 'PROXY_SOCKET_IDLE: Koneksi socket proxy diputus oleh remote server.';
    }

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
      orders: [],
      lastFetchTime: timestamp,
      isSuccess: false,
      errorMessage: errorMsg,
    };
  }

  /**
   * Menguji koneksi proxy ke server Binance Copy Trading
   */
  async testProxy(proxy?: ProxyConfig, portfolioId?: string): Promise<{ success: boolean; message: string; latencyMs: number }> {
    const start = Date.now();
    let host = (proxy?.host || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    let port = proxy?.port;
    if (host.includes(':')) {
      const parts = host.split(':');
      host = parts[0];
      if (!port && parts[1]) {
        port = parseInt(parts[1]) || null;
      }
    }

    if (!proxy || !host || !port) {
      return {
        success: false,
        message: 'Host dan Port proxy wajib diisi untuk melakukan pengujian!',
        latencyMs: 0,
      };
    }

    try {
      const cleanProxy: ProxyConfig = {
        ...proxy,
        enabled: true,
        host,
        port,
      };
      const client = await this.createClient(cleanProxy);
      const targetId = (portfolioId || '5154344801714752768').trim();
      const res = await client.get(`/bapi/futures/v1/friendly/future/copy-trade/lead-data/positions?portfolioId=${targetId}`);
      const latencyMs = Date.now() - start;
      if (res.data?.code && res.data.code !== '000000') {
        return { success: false, message: `Proxy terhubung, namun Binance merespons kode: ${res.data?.code}`, latencyMs };
      }
      return { success: true, message: 'Koneksi ke Binance Copy Trading via Proxy 100% Berhasil!', latencyMs };
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      let msg = err.message || 'Koneksi gagal';
      if (err.response?.status === 407 || err.message?.includes('407')) {
        msg = 'Autentikasi Proxy Gagal (HTTP 407). Username atau Password proxy salah, atau kuota habis.';
      } else if (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
        msg = 'Koneksi ke proxy ditolak (Connection Refused). Periksa Host dan Port proxy Anda.';
      } else if (err.code === 'ETIMEDOUT' || err.message?.includes('timeout')) {
        msg = 'Koneksi ke proxy timeout (>10 detik). Server proxy lambat atau tidak merespons.';
      } else if (err.code === 'ENOTFOUND' || err.message?.includes('ENOTFOUND')) {
        msg = 'Host proxy tidak ditemukan (DNS lookup failed). Periksa ejaan Host proxy.';
      } else if (err.response?.status === 403 || err.message?.includes('403')) {
        msg = 'Akses DITOLAK oleh Cloudflare / Binance (HTTP 403 Forbidden). IP Proxy Anda terdeteksi/terblokir, silakan coba IP atau lokasi proxy lain.';
      } else if (err.response?.status === 404) {
        msg = 'Endpoint Binance tidak ditemukan (HTTP 404).';
      } else if (
        err.message?.includes('EPROTO') ||
        err.message?.includes('wrong version number') ||
        err.message?.includes('certificate') ||
        err.message?.includes('local issuer')
      ) {
        msg = 'Gangguan handshake SSL pada node proxy. Silakan coba tes ulang.';
      }
      return { success: false, message: msg, latencyMs };
    }
  }
}

export const scraper = new CopyTradeScraper();
