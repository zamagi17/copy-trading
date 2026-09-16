export interface ProxyConfig {
  enabled: boolean;
  host: string;
  port: number | null;
  username?: string;
  password?: string;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
}

export interface AdaptivePollingConfig {
  enabled: boolean;
  dawnIntervalMs: number;      // 00:00 - 06:59 WIB (Paling Agresif / Sesi NY)
  morningIntervalMs: number;   // 07:00 - 11:59 WIB (Sedang / Sesi Asia)
  afternoonIntervalMs: number; // 12:00 - 18:59 WIB (Paling Sepi / Hemat Kuota)
  nightIntervalMs: number;     // 19:00 - 23:59 WIB (Pemanasan / Sesi London-NY)
}

export interface WeekendBreakConfig {
  enabled: boolean;
  timezone: 'CST';             // UTC+8 China Standard Time (Waktu China)
  standbyIntervalSec: number;  // Interval polling saat libur (detik, default 60s)
  blockNewTrades: boolean;     // Menolak pembukaan posisi baru selama akhir pekan (default true)
  smartReEntryEnabled?: boolean;   // Izinkan buka kembali jika posisi baru ditutup/kena SL (default true)
  reEntryWindowMinutes?: number;   // Jendela toleransi re-entry setelah close (default 30 menit)
  autoAbortOnLeaderTrade?: boolean; // Otomatis batalkan mode libur jika terdeteksi transaksi leader (default true)
}

export interface WeekendBreakStatus {
  isWeekendCST: boolean;       // Apakah saat ini Sabtu/Minggu Waktu China (CST UTC+8)
  hasOpenPositions: boolean;   // Apakah akun masih memiliki posisi terbuka
  isHolidayActive: boolean;    // Libur aktif (akhir pekan CST & tidak ada posisi terbuka & luar window re-entry)
  inReEntryWindow?: boolean;   // Sedang dalam jendela waktu tunggu toleransi re-entry
  reEntryRemainingMins?: number; // Sisa menit toleransi re-entry
  isHolidayAborted?: boolean;  // Mode libur dibatalkan karena terdeteksi transaksi dari leader
  abortedReason?: string;      // Alasan pembatalan libur (misal detail transaksi leader)
  abortedAt?: number;          // Timestamp pembatalan
  cstTimeStr: string;          // Jam & Hari Waktu China saat ini
  wibTimeStr: string;          // Jam & Hari Waktu WIB saat ini
  resumeTimeStr: string;       // Jadwal selesai libur (Senin 00:00 CST / Minggu 23:00 WIB)
}

export interface PollingStatusInfo {
  isAdaptive: boolean;
  currentIntervalMs: number;
  sessionName: string;
  sessionKey: 'dawn' | 'morning' | 'afternoon' | 'night' | 'manual' | 'weekend_break';
  wibTimeStr: string;
  cstTimeStr?: string;
  isWeekendHoliday?: boolean;
}

export interface DailyScheduleConfig {
  enabled: boolean;          // true jika jadwal istirahat aktif
  startTime: string;         // Jam mulai istirahat/mati, format "HH:mm" (WIB), default "10:00"
  endTime: string;           // Jam bangun/aktif kembali, format "HH:mm" (WIB), default "18:30"
  action: 'FULL_STOP' | 'STANDBY'; // FULL_STOP = 100% pause (0 kuota proxy), STANDBY = polling lambat 60s
  guardOpenPositions: boolean; // Tetap kawal jika ada posisi terbuka hingga 0 (default true)
}

export interface DailyScheduleStatus {
  enabled: boolean;
  isSleeping: boolean;
  startTime: string;
  endTime: string;
  action: 'FULL_STOP' | 'STANDBY';
  resumeInText: string;
  guardingPositions: boolean;
}

export interface AppConfig {
  portfolioId: string;
  copyTradeActive: boolean;
  paperTrading: boolean; // Mode simulasi gratis tanpa saldo & tanpa API key riil
  virtualBalanceUsdt: number; // Saldo simulasi untuk uji coba (default $100 USDT)
  binanceApiKey: string;
  binanceSecretKey: string;
  isTestnet: boolean;
  mode: 'RATIO_EQUITY' | 'FIXED_AMOUNT' | 'FIXED_RATIO';
  ratioMultiplier: number;
  fixedAmountUsdt: number;
  maxModalPerCoin: number;
  maxSlippagePct: number;
  syncLeverage: boolean;
  emergencySlPct: number;
  pollingIntervalMs: number;
  adaptivePolling?: AdaptivePollingConfig;
  weekendBreak?: WeekendBreakConfig;
  dailySchedule?: DailyScheduleConfig;
  proxy: ProxyConfig;
  telegram?: TelegramConfig;
  adminPassword?: string;
  jwtSecret?: string;
}

export interface LeadPosition {
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  amount: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  marginType: 'CROSSED' | 'ISOLATED';
  unrealizedProfit: number;
  notional: number;
  avgCount?: number;
  updateTime?: number;
}

export interface LeadOrderRecord {
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  action: 'OPEN' | 'CLOSE';
  executedQty: number;
  avgPrice: number;
  totalPnl: number;
  orderTime: number; // Waktu eksekusi / match (orderUpdateTime)
  orderCreationTime?: number; // Waktu order dipasang (orderTime)
  orderKey?: string; // Signature unik untuk deduplikasi order
}

export interface LeadPortfolioDetail {
  portfolioId: string;
  nickname: string;
  avatarUrl: string;
  totalEquity: number;
  roi7d: number;
  mdd7d: number;
  winRate?: number;
  copierPnl?: number;
  followerCount: number;
  maxFollowerCount: number;
  positionShow: boolean; // false jika leader me-private tab Positions
  positions: LeadPosition[];
  orders?: LeadOrderRecord[];
  lastFetchTime: number;
  isSuccess: boolean;
  errorMessage?: string;
}

export interface UserPosition {
  symbol: string;
  positionSide: 'LONG' | 'SHORT' | 'BOTH';
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unRealizedProfit: number;
  leverage: number;
  marginType: string;
  notional: number;
  margin?: number;
  avgCount?: number;
}

export interface BalanceInfo {
  totalWalletBalance: number;
  totalUnrealizedProfit: number;
  totalMarginBalance: number;
  availableBalance: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS';
  message: string;
}

export interface EngineStatus {
  isActive: boolean;
  portfolioId: string;
  lastPollTime: string | null;
  pollCount: number;
  leaderEquity: number;
  userEquity: number;
  leaderPositionsCount: number;
  userPositionsCount: number;
  activePairs: string[];
  lastError: string | null;
  pollingInfo?: PollingStatusInfo;
  weekendBreak?: WeekendBreakStatus;
  dailySchedule?: DailyScheduleStatus;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  action: 'FULL_CLOSE' | 'PARTIAL_CLOSE' | 'EMERGENCY_SL' | 'PANIC_CLOSE';
  qty: number;
  entryPrice: number;
  closePrice: number;
  realizedPnl: number;
  pnlPct: number;
  timestamp: number;
  closedAt: string;
  isPaper: boolean;
}
