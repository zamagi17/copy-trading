export interface ProxyConfig {
  enabled: boolean;
  host: string;
  port: number | null;
  username?: string;
  password?: string;
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
  proxy: ProxyConfig;
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
  orderTime: number;
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
