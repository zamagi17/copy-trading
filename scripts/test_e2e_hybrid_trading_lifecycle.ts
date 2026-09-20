import assert from 'assert';
import { CopyTradeEngine } from '../src/services/engine';
import { scraper } from '../src/services/scraper';
import { binanceClient } from '../src/services/binance';
import { LeadPosition, LeadOrderRecord, LeadPortfolioDetail } from '../src/types';

async function runLifecycleTest() {
  console.log('=== TEST E2E: HYBRID POLLING + AUTO-SNIPER & BEP GUARD LIFECYCLE ===\n');

  // Pre-populate scraper cache agar warmup constructor tidak memanggil jaringan luar
  (scraper as any).detailCache.set('5154344801714752768', {
    data: { nickname: 'Mock Leader', positionShow: true, marginBalance: 10000 },
    perf: { roi: 25 },
    lastFetch: Date.now(),
  });
  (scraper as any).detailCache.set('TEST_PORTFOLIO_HYBRID', {
    data: { nickname: 'Lifecycle Leader', positionShow: true, marginBalance: 10000 },
    perf: { roi: 25 },
    lastFetch: Date.now(),
  });

  // Siapkan instance engine dengan mode simulasi paper trading
  const engine = new CopyTradeEngine();
  const cfg = engine.getConfig();
  cfg.paperTrading = true;
  cfg.virtualBalanceUsdt = 1000;
  cfg.zeroSlippageOnly = true;
  cfg.sniperPullbackEnabled = true;
  cfg.weekendBreak = { enabled: false } as any;
  cfg.dailySchedule = { enabled: false } as any;
  cfg.hybridPolling = { enabled: true, snapshotIntervalSec: 60 };
  cfg.mode = 'RATIO_EQUITY';
  cfg.ratioMultiplier = 1.0;
  cfg.portfolioId = 'TEST_PORTFOLIO_HYBRID';

  // Bersihkan state virtual test agar tidak tercampur data disk sebelumnya
  (engine as any).virtualPositions.clear();
  (engine as any).virtualWalletBalance = 1000;
  (engine as any).closedTrades = [];
  (engine as any).slippageSkippedOrders.clear();
  (engine as any).lastLeaderPositions.clear();
  (engine as any).isFirstTick = true;

  // Simulasikan harga pasar bursa
  let simulatedMarkPrice = 65000;
  binanceClient.getSymbolPrice = async (_symbol: string) => simulatedMarkPrice;

  // Mock scraper positions & orders
  let mockPositions: LeadPosition[] = [];
  let mockOrders: LeadOrderRecord[] = [];
  let fetchPositionsCallCount = 0;

  scraper.fetchPositions = async () => {
    fetchPositionsCallCount++;
    return mockPositions.map(p => ({ ...p }));
  };

  scraper.fetchOrderHistory = async () => {
    return mockOrders.map(o => ({ ...o }));
  };

  // Override scraper.fetchPortfolioDetail untuk menggunakan logika aslinya
  (scraper as any).detailCache.set(cfg.portfolioId, {
    data: { nickname: 'Lifecycle Leader', positionShow: true, marginBalance: 10000 },
    perf: { roi: 25 },
    lastFetch: Date.now(),
  });

  // STEP 1: Cold Start Tick (Leader belum punya posisi)
  console.log('--- STEP 1: COLD START INITIAL TICK (0 POSISI) ---');
  await (engine as any).executeTick();
  assert.strictEqual(fetchPositionsCallCount, 1, 'Tick 1 harus unduh full positions (cold start)');
  let userPositions = Array.from((engine as any).virtualPositions.values()) as any[];
  assert.strictEqual(userPositions.length, 0, 'User belum punya posisi');
  console.log('✅ STEP 1 SUKSES: Cold start bersih, 0 posisi.\n');

  // STEP 2: Leader Membuka Posisi Baru (BTCUSDT LONG @ $65,000)
  console.log('--- STEP 2: LEADER OPEN BTCUSDT LONG @ $65,000 ---');
  fetchPositionsCallCount = 0;
  mockOrders.unshift({
    symbol: 'BTCUSDT',
    side: 'BUY',
    positionSide: 'LONG',
    action: 'OPEN',
    executedQty: 1.0,
    avgPrice: 65000,
    totalPnl: 0,
    orderTime: 1700000001000,
    orderCreationTime: 1700000001000,
    orderKey: 'BTCUSDT_BUY_LONG_OPEN_1.0_65000_1700000001000',
  });
  mockPositions = [
    {
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      amount: 1.0,
      entryPrice: 65000,
      markPrice: 65000,
      leverage: 10,
      marginType: 'CROSSED',
      unrealizedProfit: 0,
      notional: 65000,
      updateTime: 1700000001000,
    }
  ];

  await (engine as any).executeTick();
  assert.strictEqual(fetchPositionsCallCount, 1, 'Harus fetch full positions seketika saat order baru terdeteksi!');
  let userPositionsList = Array.from((engine as any).virtualPositions.values()) as any[];
  assert.strictEqual(userPositionsList.length, 1, 'User harus berhasil membuka 1 posisi');
  const initialQty = userPositionsList[0].positionAmt;
  const initialEntry = userPositionsList[0].entryPrice;
  assert.strictEqual(userPositionsList[0].symbol, 'BTCUSDT');
  assert.strictEqual(initialEntry, 65000);
  console.log(`✅ STEP 2 SUKSES: User membuka posisi ${userPositionsList[0].symbol} @ $${initialEntry} (Vol: ${initialQty})\n`);

  // STEP 3: Holding Tick (Tidak ada order baru, harga bergerak ke $64,000)
  console.log('--- STEP 3: HOLDING POSITION (HEMAT PROXY KUOTA) ---');
  fetchPositionsCallCount = 0;
  simulatedMarkPrice = 64000; // Harga turun

  await (engine as any).executeTick();
  assert.strictEqual(fetchPositionsCallCount, 0, 'HEMAT KUOTA: Tidak boleh fetch full positions saat holding tanpa order baru!');
  userPositionsList = Array.from((engine as any).virtualPositions.values()) as any[];
  assert.strictEqual(userPositionsList.length, 1, 'Posisi user tetap aktif');
  assert.strictEqual(userPositionsList[0].markPrice, 64000, 'Live mark price user terupdate lokal tanpa proxy');
  console.log(`✅ STEP 3 SUKSES: 0 bytes fetchPositions terbuang. Floating PnL terupdate lokal ($${userPositionsList[0].unRealizedProfit.toFixed(2)} USDT)\n`);

  // STEP 4: Leader Menambah Muatan (Averaging Down @ $60,000) saat harga di pasar sudah memantul ke $62,000
  console.log('--- STEP 4: LEADER DCA @ $60,000, HARGA PASAR MEMANTUL KE $62,000 ---');
  fetchPositionsCallCount = 0;
  simulatedMarkPrice = 62000; // Harga pasar lebih mahal dari layer Leader ($62.000 vs $60.000) -> Risiko BEP!

  mockOrders.unshift({
    symbol: 'BTCUSDT',
    side: 'BUY',
    positionSide: 'LONG',
    action: 'OPEN',
    executedQty: 1.0,
    avgPrice: 60000,
    totalPnl: 0,
    orderTime: 1700000005000,
    orderCreationTime: 1700000005000,
    orderKey: 'BTCUSDT_BUY_LONG_OPEN_1.0_60000_1700000005000',
  });

  // Posisi baru leader: 2 BTC total, rata-rata $62,500
  mockPositions = [
    {
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      amount: 2.0,
      entryPrice: 62500, // (1 * 65000 + 1 * 60000) / 2 = 62500
      markPrice: 62000,
      leverage: 10,
      marginType: 'CROSSED',
      unrealizedProfit: -1000,
      notional: 124000,
      updateTime: 1700000005000,
    }
  ];

  await (engine as any).executeTick();
  assert.strictEqual(fetchPositionsCallCount, 1, 'Harus fetch full positions seketika saat order DCA terdeteksi!');

  // Verifikasi: Order averaging down harus DITAHAN di Auto-Sniper Pullback untuk melindungi BEP!
  const skippedOrders = Array.from((engine as any).slippageSkippedOrders.values()) as any[];
  assert.strictEqual(skippedOrders.length, 1, 'Order averaging down harus masuk antrean Auto-Sniper');
  const skippedAvg = skippedOrders[0];
  assert.strictEqual(skippedAvg.type, 'AVERAGING');
  assert.strictEqual(skippedAvg.targetPullbackPrice, 60000, 'Target pullback harus terkunci pada harga layer leader ($60,000)');
  console.log(`✅ STEP 4 SUKSES: Auto-Sniper & BEP Guard berhasil menahan order averaging! Target Pullback: $${skippedAvg.targetPullbackPrice}\n`);

  // STEP 5: Harga Mengalami Pullback ke $60,000 -> Auto-Sniper Otomatis Eksekusi!
  console.log('--- STEP 5: HARGA PASAR PULLBACK KE $59,950 (MATCH AUTO-SNIPER) ---');
  simulatedMarkPrice = 59950; // Pullback diskon lebih murah dari $60,000!

  await (engine as any).executeTick();
  const skippedAfterPullback = Array.from((engine as any).slippageSkippedOrders.values());
  assert.strictEqual(skippedAfterPullback.length, 0, 'Antrean Auto-Sniper harus selesai dieksekusi');
  userPositionsList = Array.from((engine as any).virtualPositions.values()) as any[];
  const averagedUserPos = userPositionsList[0];
  assert(averagedUserPos.positionAmt > initialQty, 'Volume user harus bertambah setelah averaging');
  assert(averagedUserPos.entryPrice < initialEntry, 'Rata-rata harga user harus turun menguntungkan');
  console.log(`✅ STEP 5 SUKSES: Auto-Sniper mengeksekusi averaging down saat pullback! Rata-rata akhir user: $${averagedUserPos.entryPrice.toFixed(2)} (Leader: $62,500 - BEP SAFE!)\n`);

  // STEP 6: Leader Menutup Penuh Posisi (Full Close)
  console.log('--- STEP 6: LEADER MENUTUP PENUH POSISI (FULL CLOSE) ---');
  fetchPositionsCallCount = 0;
  simulatedMarkPrice = 63000;

  mockOrders.unshift({
    symbol: 'BTCUSDT',
    side: 'SELL',
    positionSide: 'LONG',
    action: 'CLOSE',
    executedQty: 2.0,
    avgPrice: 63000,
    totalPnl: 1000,
    orderTime: 1700000010000,
    orderCreationTime: 1700000010000,
    orderKey: 'BTCUSDT_SELL_LONG_CLOSE_2.0_63000_1700000010000',
  });
  mockPositions = []; // Posisi di bursa kosong (0 posisi)

  await (engine as any).executeTick();
  assert.strictEqual(fetchPositionsCallCount, 1, 'Harus fetch full positions seketika saat order close terdeteksi!');
  userPositionsList = Array.from((engine as any).virtualPositions.values()) as any[];
  assert.strictEqual(userPositionsList.length, 0, 'Posisi user harus ditutup penuh seketika!');
  const closedTrades = (engine as any).closedTrades as any[];
  assert(closedTrades.length > 0, 'Harus ada riwayat trade yang ditutup');
  assert(closedTrades[0].realizedPnl > 0, 'User harus menghasilkan profit yang terealisasi');
  console.log(`✅ STEP 6 SUKSES: Posisi user ditutup penuh seketika! Realized PnL: +$${closedTrades[0].realizedPnl.toFixed(2)} USDT. Saldo akhir: $${(engine as any).virtualWalletBalance.toFixed(2)} USDT\n`);

  console.log('🎉 SELURUH SKENARIO LIFECYCLE TRADING BERJALAN 100% SEMPURNA TANPA BUG!');
}

runLifecycleTest().catch((err) => {
  console.error('❌ E2E Test Failed:', err);
  process.exit(1);
});
