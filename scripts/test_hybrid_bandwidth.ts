import assert from 'assert';
import { CopyTradeScraper } from '../src/services/scraper';
import { LeadPosition, LeadOrderRecord } from '../src/types';

async function runTests() {
  console.log('🚀 [TEST] Memulai pengujian Hybrid Bandwidth Saver & Brotli...\n');

  const scraper = new CopyTradeScraper();

  // Mock state untuk scraper
  let positionsFetchCount = 0;
  let orderHistoryFetchCount = 0;
  let mockPositions: LeadPosition[] = [
    {
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      amount: 0.5,
      entryPrice: 65000,
      markPrice: 65500,
      leverage: 20,
      marginType: 'CROSSED',
      unrealizedProfit: 250,
      notional: 32750,
    }
  ];

  let mockOrders: LeadOrderRecord[] = [
    {
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      action: 'OPEN',
      executedQty: 0.5,
      avgPrice: 65000,
      totalPnl: 0,
      orderTime: 1700000000000,
      orderCreationTime: 1700000000000,
      orderKey: 'BTCUSDT_BUY_LONG_OPEN_0.5_65000_1700000000000_1700000000000',
    }
  ];

  // Mock method fetchPositions dan fetchOrderHistory
  scraper.fetchPositions = async (_id: string) => {
    positionsFetchCount++;
    return [...mockPositions];
  };

  scraper.fetchOrderHistory = async (_id: string, _proxy?: any, _pageSize?: number) => {
    orderHistoryFetchCount++;
    return [...mockOrders];
  };

  // Mock internal detailCache agar tidak request HTTP ke Binance sungguhan
  (scraper as any).detailCache.set('LEADER_PUBLIC', {
    data: { nickname: 'Public Leader', positionShow: true },
    perf: { roi: 50 },
    lastFetch: Date.now(),
  });

  (scraper as any).detailCache.set('LEADER_PRIVATE', {
    data: { nickname: 'Private Leader', positionShow: false },
    perf: { roi: 40 },
    lastFetch: Date.now(),
  });

  // TEST 1: LEADER PRIVATE TETAP 100% SAMA (TIDAK DIUBAH LOGIKANYA)
  console.log('Test 1: Leader Private (positionShow === false)');
  positionsFetchCount = 0;
  orderHistoryFetchCount = 0;

  const privRes = await (scraper as any)._doFetchPortfolioDetail('LEADER_PRIVATE', undefined, 1000, { enabled: true, snapshotIntervalSec: 60 });
  assert.strictEqual(privRes.positionShow, false, 'Harus mode private');
  assert.strictEqual(positionsFetchCount, 0, 'Private leader TIDAK BOLEH memanggil fetchPositions');
  assert.strictEqual(orderHistoryFetchCount, 1, 'Private leader harus memanggil fetchOrderHistory');
  assert.strictEqual(privRes.orders.length, 1, 'Orders harus dikembalikan');
  console.log('  ✅ PASS: Private leader tetap 100% menggunakan order-history, logika tidak diubah!\n');

  // TEST 2: LEADER PUBLIK - TICK 1 (COLD START)
  console.log('Test 2: Leader Public - Tick 1 (Cold Start Baseline)');
  positionsFetchCount = 0;
  orderHistoryFetchCount = 0;

  const pubTick1 = await (scraper as any)._doFetchPortfolioDetail('LEADER_PUBLIC', undefined, 1000, { enabled: true, snapshotIntervalSec: 60 });
  assert.strictEqual(pubTick1.positionShow, true, 'Harus mode public');
  assert.strictEqual(positionsFetchCount, 1, 'Tick 1 harus unduh full positions (cold start)');
  assert.strictEqual(orderHistoryFetchCount, 1, 'Tick 1 harus mencatat baseline order history');
  assert.strictEqual(pubTick1.positions.length, 1);
  console.log('  ✅ PASS: Tick 1 berhasil cold-start download full positions & catat baseline!\n');

  // TEST 3: LEADER PUBLIK - TICK 2 (IDLE / HOLDING, TIDAK ADA TRANSAKSI BARU)
  console.log('Test 3: Leader Public - Tick 2 (Holding / Idle, 0 Transaksi Baru)');
  positionsFetchCount = 0;
  orderHistoryFetchCount = 0;

  const pubTick2 = await (scraper as any)._doFetchPortfolioDetail('LEADER_PUBLIC', undefined, 2800, { enabled: true, snapshotIntervalSec: 60 });
  assert.strictEqual(positionsFetchCount, 0, 'TIDAK BOLEH unduh full positions saat idle (Hemat kuota 190 KB -> 0 KB!)');
  assert.strictEqual(orderHistoryFetchCount, 1, 'Hanya fetch order history ringan (~1 KB)');
  assert.strictEqual(pubTick2.positions.length, 1, 'Positions diambil dari cache');
  assert.strictEqual(pubTick2.positions[0].symbol, 'BTCUSDT');
  console.log('  ✅ PASS: Menghemat kuota proxy 190 KB per 1.8 detik saat holding!\n');

  // TEST 4: LEADER PUBLIK - TICK 3 (TRANSAKSI BARU OLEH LEADER -> INSTANT TRIGGER ZERO LATENCY)
  console.log('Test 4: Leader Public - Tick 3 (Order Baru Terjadi -> Smart Trigger Instan)');
  positionsFetchCount = 0;
  orderHistoryFetchCount = 0;

  // Leader melakukan averaging down / order baru:
  mockOrders.unshift({
    symbol: 'BTCUSDT',
    side: 'BUY',
    positionSide: 'LONG',
    action: 'OPEN',
    executedQty: 0.5,
    avgPrice: 64800,
    totalPnl: 0,
    orderTime: 1700000004500, // Timestamp lebih baru
    orderCreationTime: 1700000004500,
    orderKey: 'BTCUSDT_BUY_LONG_OPEN_0.5_64800_1700000004500_1700000004500',
  });

  // Updated position di bursa:
  mockPositions[0].amount = 1.0;
  mockPositions[0].entryPrice = 64900;

  const pubTick3 = await (scraper as any)._doFetchPortfolioDetail('LEADER_PUBLIC', undefined, 4600, { enabled: true, snapshotIntervalSec: 60 });
  assert.strictEqual(positionsFetchCount, 1, 'Wajib langsung fetch full positions seketika saat order baru terdeteksi!');
  assert.strictEqual(pubTick3.positions[0].amount, 1.0, 'Posisi terbaru harus terupdate');
  assert.strictEqual(pubTick3.positions[0].entryPrice, 64900);
  console.log('  ✅ PASS: Zero latency! Seketika ada order baru, langsung unduh posisi penuh!\n');

  // TEST 5: LEADER PUBLIK - TICK 4 (PERIODIC HEARTBEAT SNAPSHOT SETELAH 60s)
  console.log('Test 5: Leader Public - Tick 4 (Periodic Snapshot Heartbeat 60s)');
  positionsFetchCount = 0;
  orderHistoryFetchCount = 0;

  // Lewat 65 detik sejak fetch terakhir (4600 + 65000 = 69600)
  const pubTick4 = await (scraper as any)._doFetchPortfolioDetail('LEADER_PUBLIC', undefined, 69600, { enabled: true, snapshotIntervalSec: 60 });
  assert.strictEqual(positionsFetchCount, 1, 'Heartbeat 60s harus trigger full positions untuk rekonsiliasi data');
  console.log('  ✅ PASS: Heartbeat snapshot berkala berjalan normal demi keamanan data!\n');

  // TEST 6: HYBRID DISABLED (FALLBACK PENUH)
  console.log('Test 6: Leader Public - Hybrid Disabled (Opsi Klasik)');
  positionsFetchCount = 0;
  orderHistoryFetchCount = 0;

  await (scraper as any)._doFetchPortfolioDetail('LEADER_PUBLIC', undefined, 71000, { enabled: false, snapshotIntervalSec: 60 });
  assert.strictEqual(positionsFetchCount, 1, 'Jika disabled, selalu fetch full positions');
  console.log('  ✅ PASS: Mode fallback klasik bekerja sempurna saat dimatikan.\n');

  console.log('🎉 SEMUA PENGUJIAN HYBRID BANDWIDTH SAVER & PRIVATE LEADER SUKSES 100%!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
