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
  timezone: 'WIB' | 'CST';     // UTC+7 Waktu Indonesia Barat (WIB)
  standbyIntervalSec: number;  // Interval polling saat libur (detik, default 60s)
  blockNewTrades: boolean;     // Menolak pembukaan posisi baru selama akhir pekan (default true)
  smartReEntryEnabled?: boolean;   // Izinkan buka kembali jika posisi baru ditutup/kena SL (default true)
  reEntryWindowMinutes?: number;   // Jendela toleransi re-entry setelah close (default 30 menit)
  autoAbortOnLeaderTrade?: boolean; // Otomatis batalkan mode libur jika terdeteksi transaksi leader (default true)
}

export interface WeekendBreakStatus {
  isWeekendWIB: boolean;       // Apakah saat ini Sabtu/Minggu Waktu Indonesia Barat (WIB UTC+7)
  isWeekendCST?: boolean;      // Alias kompatibilitas
  hasOpenPositions: boolean;   // Apakah akun masih memiliki posisi terbuka
  isHolidayActive: boolean;    // Libur aktif (akhir pekan WIB & tidak ada posisi terbuka & luar window re-entry)
  inReEntryWindow?: boolean;   // Sedang dalam jendela waktu tunggu toleransi re-entry
  reEntryRemainingMins?: number; // Sisa menit toleransi re-entry
  isHolidayAborted?: boolean;  // Mode libur dibatalkan karena terdeteksi transaksi dari leader
  abortedReason?: string;      // Alasan pembatalan libur (misal detail transaksi leader)
  abortedAt?: number;          // Timestamp pembatalan
  wibTimeStr: string;          // Jam & Hari Waktu WIB saat ini
  cstTimeStr?: string;         // Alias kompatibilitas
  resumeTimeStr: string;       // Jadwal selesai libur (Senin 00:00 WIB)
}

export interface IdleStandbyConfig {
  enabled: boolean;          // true jika mode jeda hemat saat 0 posisi aktif (default true)
  idleIntervalSec: number;   // Jeda polling saat tidak ada posisi (detik, default 5.0)
}

export interface PollingStatusInfo {
  isAdaptive: boolean;
  currentIntervalMs: number;
  sessionName: string;
  sessionKey: 'dawn' | 'morning' | 'afternoon' | 'night' | 'manual' | 'weekend_break' | 'idle_standby';
  wibTimeStr: string;
  cstTimeStr?: string;
  isWeekendHoliday?: boolean;
  isIdleStandby?: boolean;
}

export interface DailyScheduleConfig {
  enabled: boolean;          // true jika jadwal istirahat aktif
  startTime: string;         // Jam mulai istirahat/mati, format "HH:mm" (WIB), default "10:00"
  endTime: string;           // Jam bangun/aktif kembali, format "HH:mm" (WIB), default "18:30"
  action: 'FULL_STOP' | 'STANDBY'; // FULL_STOP = 100% pause (0 kuota proxy), STANDBY = polling lambat 60s
  guardOpenPositions: boolean; // Tetap kawal jika ada posisi terbuka hingga 0 (default true)
  autoAbortOnLeaderTrade?: boolean; // Otomatis batalkan istirahat jika polling 60s mendeteksi transaksi leader (default true)
}

export interface DailyScheduleStatus {
  enabled: boolean;
  isSleeping: boolean;
  startTime: string;
  endTime: string;
  action: 'FULL_STOP' | 'STANDBY';
  resumeInText: string;
  guardingPositions: boolean;
  isScheduleAborted?: boolean;
  abortedReason?: string;
  abortedAt?: number;
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
  reverseTrading?: boolean; // Mode inverse trading (Leader Long -> User Short, Leader Short -> User Long)
  reorderWindowMinutes?: number; // Batas toleransi waktu order susulan (re-order) dalam satuan menit (default: 30)
  zeroSlippageOnly?: boolean; // Hanya izinkan eksekusi jika harga sama atau lebih menguntungkan dari leader (Slippage 0 atau Plus)
  sniperPullbackEnabled?: boolean; // Otomatis mengeksekusi order tertahan saat harga pullback ke entry leader (default true)
  syncLeverage: boolean;
  emergencySlPct: number;
  pollingIntervalMs: number;
  adaptivePolling?: AdaptivePollingConfig;
  idleStandby?: IdleStandbyConfig;
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
  slippageSkippedOrders?: SkippedOrderInfo[];
  isIdleStandby?: boolean;
}

export interface SkippedOrderInfo {
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  type: 'NEW_POSITION' | 'AVERAGING';
  leaderEntryPrice: number;
  markPrice: number;
  slippagePct: number;
  adverseSlippagePct?: number;
  targetPullbackPrice?: number;
  isSniperPending?: boolean;
  notifiedSniper?: boolean;
  skippedAt: number;
  reason?: string;
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

export interface DailyBalanceSnapshot {
  date: string; // "YYYY-MM-DD"
  walletBalance: number;
  marginBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  realizedPnlToday: number;
  tradesCountToday: number;
  winCountToday: number;
  lossCountToday: number;
  winRateToday: number;
  openPositionsCount: number;
  timestamp: number;
  createdAt?: string;
}
