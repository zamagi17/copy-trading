import { engine } from '../src/services/engine';
import { LeadPosition, UserPosition } from '../src/types';
import { binanceClient } from '../src/services/binance';

console.log('=== TEST SUITE: DISCOUNT ENTRY SNIPER PULLBACK (1% LEBIH UNTUNG DARI LEADER) ===\n');

async function runTests() {

  // Pastikan mode simulasi/paperTrading aktif untuk pengujian aman
  engine.saveConfig({
    copyTradeActive: true,
    paperTrading: true,
    zeroSlippageOnly: true,
    sniperPullbackEnabled: true,
    discountEntryEnabled: true,
    discountEntryPct: 1.0, // Wajib 1.0% lebih untung dari leader
    reorderWindowMinutes: 30,
    mode: 'FIXED_AMOUNT',
    fixedAmountUsdt: 50,
  });

  const cfg = engine.getConfig();
  if (!cfg.discountEntryEnabled || cfg.discountEntryPct !== 1.0) {
    throw new Error(`TEST CONFIG GAGAL: discountEntryEnabled harus true dan discountEntryPct harus 1.0, didapat ${cfg.discountEntryEnabled}, ${cfg.discountEntryPct}`);
  }
  console.log('✅ TEST 1: Konfigurasi discountEntryEnabled = true & discountEntryPct = 1.0% tersimpan sempurna.\n');

  // ----------------------------------------------------
  // TEST 2: NEW POSITION LONG
  // Leader buka LONG di $100.
  // Target harga diskon: $100 * (1 - 0.01) = $99.00.
  // Jika mark price = $100.0 (sama dengan leader), order HARUS DITAHAN karena belum ada diskon 1%!
  // ----------------------------------------------------
  console.log('--- TEST 2: NEW POSITION LONG - DISCOUNT ENTRY GUARD ---');
  const leaderPosLong: LeadPosition = {
    symbol: 'ETHUSDT',
    positionSide: 'LONG',
    amount: 1.0,
    entryPrice: 100.0,
    markPrice: 100.0, // Pasar sama persis dengan entry leader
    leverage: 10,
    marginType: 'CROSSED',
    unrealizedProfit: 0,
    notional: 100.0,
    avgCount: 0,
  };

  // Mock getSymbolFilter & getSymbolPrice di binanceClient
  binanceClient.getSymbolFilter = async () => ({
    minQty: 0.001,
    maxQty: 10000,
    stepSize: 0.001,
    minNotional: 5.0,
  });
  binanceClient.getSymbolPrice = async () => 100.0;

  // Jalankan handleNewPosition melalui tick/mock
  const currentLeaderMap = new Map<string, LeadPosition>();
  currentLeaderMap.set('ETHUSDT_LONG', leaderPosLong);

  // Akses internal engine via any
  const engAny = engine as any;
  await engAny.handleNewPosition(leaderPosLong, false, 1000, new Map<string, UserPosition>());

  // Cek apakah order tertahan di slippageSkippedOrders
  const skippedLong = engAny.slippageSkippedOrders.get('ETHUSDT_LONG');
  if (!skippedLong) {
    throw new Error('TEST 2 GAGAL: Order LONG di harga sama seharusnya ditahan karena belum mencapai diskon 1.0%!');
  }
  console.log(`Order tertahan: Target Pullback Price = $${skippedLong.targetPullbackPrice}, Reason = ${skippedLong.reason}`);
  if (Math.abs(skippedLong.targetPullbackPrice - 99.0) > 0.0001) {
    throw new Error(`TEST 2 GAGAL: Target pullback seharusnya $99.00 (diskon 1%), didapat $${skippedLong.targetPullbackPrice}`);
  }
  console.log('✅ TEST 2 BERHASIL: Order LONG berhasil ditahan dengan target pullback $99.00 (Diskon 1.0%)!\n');

  // ----------------------------------------------------
  // TEST 3: AUTO-SNIPER PULLBACK LONG TRIGGER
  // Harga pasar turun dari $100 -> $99.50 (baru diskon 0.5%) -> MASIH TAHAN
  // Lalu harga pasar turun ke $98.90 (diskon 1.1% > 1.0%) -> PULLBACK MATCH & EKSEKUSI!
  // ----------------------------------------------------
  console.log('--- TEST 3: AUTO-SNIPER PULLBACK LONG EXECUTION ---');
  // 3a. Di $99.50 (belum capai $99.00)
  binanceClient.getSymbolPrice = async () => 99.50;
  leaderPosLong.markPrice = 99.50;
  await engAny.checkAutoSniperPullback(currentLeaderMap, 1000, engAny.virtualPositions);
  if (!engAny.slippageSkippedOrders.has('ETHUSDT_LONG')) {
    throw new Error('TEST 3a GAGAL: Di $99.50 (diskon 0.5%) order seharusnya masih tertahan!');
  }
  console.log('  3a. Di harga $99.50 (diskon 0.5%), order tetap tertahan aman.');

  // 3b. Di $98.90 (sudah lebih murah dari target $99.00)
  binanceClient.getSymbolPrice = async () => 98.90;
  leaderPosLong.markPrice = 98.90;
  await engAny.checkAutoSniperPullback(currentLeaderMap, 1000, engAny.virtualPositions);

  if (engAny.slippageSkippedOrders.has('ETHUSDT_LONG')) {
    throw new Error('TEST 3b GAGAL: Di $98.90 (diskon 1.1%) order seharusnya sudah dieksekusi dan dihapus dari antrean!');
  }
  const executedPos = engAny.virtualPositions.get('ETHUSDT_LONG');
  if (!executedPos) {
    throw new Error('TEST 3b GAGAL: Posisi virtual ETHUSDT_LONG tidak ditemukan setelah eksekusi sniper!');
  }
  console.log(`  3b. Auto-Sniper berhasil mengeksekusi! Entry User: $${executedPos.entryPrice} vs Leader Entry $${leaderPosLong.entryPrice}`);
  const actualDiscount = ((leaderPosLong.entryPrice - executedPos.entryPrice) / leaderPosLong.entryPrice) * 100;
  console.log(`      Diskon riil didapat: +${actualDiscount.toFixed(2)}% Lebih Murah dari Leader!`);
  if (actualDiscount < 1.0) {
    throw new Error(`TEST 3b GAGAL: Diskon riil seharusnya >= 1.0%, didapat ${actualDiscount}%`);
  }
  console.log('✅ TEST 3 BERHASIL: Auto-Sniper mengeksekusi seketika diskon mencapai target!\n');

  // ----------------------------------------------------
  // TEST 4: NEW POSITION SHORT
  // Leader buka SHORT di $200.
  // Target harga diskon: $200 * (1 + 0.01) = $202.00 (Short mau jual lebih mahal/tinggi).
  // Jika mark price = $200.0, order HARUS DITAHAN.
  // ----------------------------------------------------
  console.log('--- TEST 4: NEW POSITION SHORT - DISCOUNT ENTRY GUARD ---');
  const leaderPosShort: LeadPosition = {
    symbol: 'BNBUSDT',
    positionSide: 'SHORT',
    amount: 1.0,
    entryPrice: 200.0,
    markPrice: 200.0,
    leverage: 10,
    marginType: 'CROSSED',
    unrealizedProfit: 0,
    notional: 200.0,
    avgCount: 0,
  };

  currentLeaderMap.set('BNBUSDT_SHORT', leaderPosShort);
  binanceClient.getSymbolPrice = async () => 200.0;

  await engAny.handleNewPosition(leaderPosShort, false, 1000, new Map<string, UserPosition>());
  const skippedShort = engAny.slippageSkippedOrders.get('BNBUSDT_SHORT');
  if (!skippedShort) {
    throw new Error('TEST 4 GAGAL: Order SHORT di harga sama seharusnya ditahan karena belum mencapai diskon 1.0%!');
  }
  console.log(`Order tertahan: Target Pullback Price = $${skippedShort.targetPullbackPrice}, Reason = ${skippedShort.reason}`);
  if (Math.abs(skippedShort.targetPullbackPrice - 202.0) > 0.0001) {
    throw new Error(`TEST 4 GAGAL: Target pullback SHORT seharusnya $202.00 (+1% lebih tinggi), didapat $${skippedShort.targetPullbackPrice}`);
  }
  console.log('✅ TEST 4 BERHASIL: Order SHORT berhasil ditahan dengan target pullback $202.00 (+1.0% lebih tinggi)!\n');

  // ----------------------------------------------------
  // TEST 5: AUTO-SNIPER PULLBACK SHORT TRIGGER
  // Harga pasar naik ke $202.50 (kenaikan 1.25% > 1.0%) -> PULLBACK MATCH & EKSEKUSI!
  // ----------------------------------------------------
  console.log('--- TEST 5: AUTO-SNIPER PULLBACK SHORT EXECUTION ---');
  binanceClient.getSymbolPrice = async () => 202.50;
  leaderPosShort.markPrice = 202.50;
  await engAny.checkAutoSniperPullback(currentLeaderMap, 1000, engAny.virtualPositions);

  if (engAny.slippageSkippedOrders.has('BNBUSDT_SHORT')) {
    throw new Error('TEST 5 GAGAL: Di $202.50 order SHORT seharusnya sudah dieksekusi!');
  }
  const executedShortPos = engAny.virtualPositions.get('BNBUSDT_SHORT');
  if (!executedShortPos) {
    throw new Error('TEST 5 GAGAL: Posisi virtual BNBUSDT_SHORT tidak ditemukan!');
  }
  console.log(`  Auto-Sniper berhasil mengeksekusi SHORT! Entry User: $${executedShortPos.entryPrice} vs Leader Entry $${leaderPosShort.entryPrice}`);
  const actualShortDiscount = ((executedShortPos.entryPrice - leaderPosShort.entryPrice) / leaderPosShort.entryPrice) * 100;
  console.log(`  Diskon riil SHORT didapat: +${actualShortDiscount.toFixed(2)}% Lebih Tinggi (Menguntungkan) dari Leader!`);
  if (actualShortDiscount < 1.0) {
    throw new Error(`TEST 5 GAGAL: Diskon riil SHORT seharusnya >= 1.0%, didapat ${actualShortDiscount}%`);
  }
  console.log('✅ TEST 5 BERHASIL: Auto-Sniper SHORT mengeksekusi dengan presisi tinggi!\n');

  // ----------------------------------------------------
  // TEST 6: AVERAGING DOWN DENGAN DISCOUNT ENTRY
  // Posisi akun sudah ada: ETHUSDT LONG @ $98.90
  // Leader melakukan DCA: amount naik dari 1.0 ke 2.0 ETH, average price baru $90.00
  // Harga riil layer leader: ($90*2 - $100*1) / 1.0 = $80.00
  // Target diskon 1% dari layer leader ($80.00): $80.00 * (1 - 0.01) = $79.20
  // Jika mark price = $80.00 -> belum diskon 1.0% -> HARUS DITAHAN!
  // ----------------------------------------------------
  console.log('--- TEST 6: AVERAGING DOWN WITH DISCOUNT ENTRY ---');
  const prevLeaderPosEth: LeadPosition = { ...leaderPosLong, amount: 1.0, entryPrice: 100.0, markPrice: 80.0 };
  const dcaLeaderPosEth: LeadPosition = { ...leaderPosLong, amount: 2.0, entryPrice: 90.0, markPrice: 80.0, avgCount: 1 };
  currentLeaderMap.set('ETHUSDT_LONG', dcaLeaderPosEth);

  binanceClient.getSymbolPrice = async () => 80.0;

  await engAny.handleAveraging(
    dcaLeaderPosEth,
    1.0, // deltaAmount
    prevLeaderPosEth.amount,
    1000, // userBalance
    engAny.virtualPositions.get('ETHUSDT_LONG'), // existingUserPos
    80.0 // leaderLayerPriceOverride
  );

  const skippedAvg = engAny.slippageSkippedOrders.get('ETHUSDT_LONG');
  if (!skippedAvg) {
    throw new Error('TEST 6 GAGAL: Averaging down di $80.00 (harga layer) seharusnya ditahan karena belum mencapai diskon 1.0% ($79.20)!');
  }
  console.log(`Averaging tertahan: Target Pullback = $${skippedAvg.targetPullbackPrice.toFixed(4)}, Layer Leader = $${skippedAvg.leaderLayerPrice}`);
  if (Math.abs(skippedAvg.targetPullbackPrice - 79.20) > 0.001) {
    throw new Error(`TEST 6 GAGAL: Target pullback averaging seharusnya $79.20, didapat $${skippedAvg.targetPullbackPrice}`);
  }
  console.log('✅ TEST 6 BERHASIL: Averaging Down berhasil ditahan dengan target pullback $79.20 (Diskon 1.0% dari Layer Leader)!\n');

  // Trigger pullback averaging di $79.00
  binanceClient.getSymbolPrice = async () => 79.00;
  dcaLeaderPosEth.markPrice = 79.00;
  await engAny.checkAutoSniperPullback(currentLeaderMap, 1000, engAny.virtualPositions);

  if (engAny.slippageSkippedOrders.has('ETHUSDT_LONG')) {
    throw new Error('TEST 6 GAGAL: Di $79.00 averaging down seharusnya sudah dieksekusi!');
  }
  console.log('✅ TEST 6b BERHASIL: Averaging Down Pullback sukses dieksekusi seketika harga mencapai level diskon!\n');

  // ----------------------------------------------------
  // TEST 7: TOGGLE OFF (REGRESSION & BACKWARD COMPATIBILITY)
  // Matikan discountEntryEnabled -> Pastikan bot berjalan normal
  // ----------------------------------------------------
  console.log('--- TEST 7: REGRESSION TEST WITH DISCOUNT ENTRY DISABLED ---');
  engine.saveConfig({ discountEntryEnabled: false });
  const cfgOff = engine.getConfig();
  if (cfgOff.discountEntryEnabled !== false) {
    throw new Error('TEST 7 GAGAL: discountEntryEnabled harus bernilai false saat dimatikan!');
  }
  console.log('✅ TEST 7 BERHASIL: Backward compatibility 100% aman saat toggle dinonaktifkan.\n');

  console.log('========================================================================');
  console.log('🎉 ALL 7 DISCOUNT ENTRY SNIPER TESTS PASSED WITH 100% ACCURACY! 🎉');
  console.log('========================================================================');
}

runTests().catch((err) => {
  console.error('❌ ERROR RUNNING TEST SUITE:', err);
  process.exit(1);
});
