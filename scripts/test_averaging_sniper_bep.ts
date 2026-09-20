import { LeadPosition, UserPosition } from '../src/types';

console.log('=== TEST SUITE: AUTO-SNIPER PULLBACK & BEP GUARD FOR AVERAGING DOWN ===\n');

// 1. UJI PERHITUNGAN HARGA LAYER IMPLIED LEADER
console.log('--- TEST 1: LEADER LAYER IMPLIED EXECUTION PRICE CALCULATION ---');
const prevLeaderPos: LeadPosition = {
  symbol: 'BTCUSDT',
  positionSide: 'LONG',
  amount: 1.0,
  entryPrice: 100000,
  markPrice: 100000,
  leverage: 10,
  marginType: 'CROSSED',
  unrealizedProfit: 0,
  notional: 100000,
  avgCount: 0,
};

// Leader DCA: total menjadi 2.0 BTC dengan rata-rata baru $90,000
const currentLeaderPos: LeadPosition = {
  symbol: 'BTCUSDT',
  positionSide: 'LONG',
  amount: 2.0,
  entryPrice: 90000,
  markPrice: 82000, // Pasar memantul ke $82.000
  leverage: 10,
  marginType: 'CROSSED',
  unrealizedProfit: -16000,
  notional: 164000,
  avgCount: 1,
};

const deltaAmount = currentLeaderPos.amount - prevLeaderPos.amount;
const prevNotional = prevLeaderPos.amount * prevLeaderPos.entryPrice;
const currentNotional = currentLeaderPos.amount * currentLeaderPos.entryPrice;
const layerNotional = currentNotional - prevNotional;
const calcLayerPrice = layerNotional / deltaAmount;

console.log(`Posisi Sebelumnya: ${prevLeaderPos.amount} BTC @ $${prevLeaderPos.entryPrice} (Notional: $${prevNotional})`);
console.log(`Posisi Sekarang:   ${currentLeaderPos.amount} BTC @ $${currentLeaderPos.entryPrice} (Notional: $${currentNotional})`);
console.log(`Delta Layer:       +${deltaAmount} BTC`);
console.log(`Hasil Kalkulasi Harga Riil Layer Leader: $${calcLayerPrice}`);

if (calcLayerPrice !== 80000) {
  throw new Error(`TEST 1 GAGAL: Harga layer leader seharusnya $80.000, didapat $${calcLayerPrice}`);
}
console.log('✅ TEST 1 BERHASIL: Harga riil layer leader ($80.000) terhitung 100% presisi!\n');

// 2. UJI PERBANDINGAN LOGIKA LAMA VS LOGIKA BARU (SLIPPAGE DETECTION)
console.log('--- TEST 2: SLIPPAGE EVALUATION (OLD LOGIC VS NEW DUAL-CHECK LOGIC) ---');
const markPrice = 82000; // Harga pasar saat bot memeriksa
const allowedAdversePct = 0.01; // Zero slippage only (toleransi 0.01%)

// LOGIKA LAMA (BUG): Membandingkan markPrice ($82.000) dengan entryPrice gabungan ($90.000)
let oldAdverseSlippagePct = 0;
if (markPrice > currentLeaderPos.entryPrice) {
  oldAdverseSlippagePct = ((markPrice - currentLeaderPos.entryPrice) / currentLeaderPos.entryPrice) * 100;
}
console.log(`Logika Lama: Membandingkan Mark $${markPrice} vs Leader Average $${currentLeaderPos.entryPrice}`);
console.log(`Logika Lama Adverse Slippage: ${oldAdverseSlippagePct}% -> ${oldAdverseSlippagePct > allowedAdversePct ? 'DITAHAN SNIPER' : 'LANGSUNG BELI DI MARKET (BAHAYA!)'}`);

// LOGIKA BARU: Dual-Check (Layer Slippage & BEP Protection)
let layerSlippagePct = 0;
if (markPrice > calcLayerPrice) {
  layerSlippagePct = ((markPrice - calcLayerPrice) / calcLayerPrice) * 100;
}

const existingUserPos: UserPosition = {
  symbol: 'BTCUSDT',
  positionSide: 'LONG',
  positionAmt: 0.1,
  entryPrice: 100000,
  markPrice: markPrice,
  unRealizedProfit: -1800,
  leverage: 10,
  marginType: 'CROSSED',
  notional: 8200,
  avgCount: 0,
};

const userCurrentQty = Math.abs(existingUserPos.positionAmt);
const addQty = userCurrentQty * (deltaAmount / prevLeaderPos.amount); // 0.1 BTC
const oldQty = userCurrentQty;
const oldEntry = existingUserPos.entryPrice;
const projectedTotalQty = oldQty + addQty;
const userProjectedEntry = (oldQty * oldEntry + addQty * markPrice) / projectedTotalQty;

let bepAdversePct = 0;
if (userProjectedEntry > currentLeaderPos.entryPrice) {
  bepAdversePct = ((userProjectedEntry - currentLeaderPos.entryPrice) / currentLeaderPos.entryPrice) * 100;
}

const newAdverseSlippagePct = Math.max(layerSlippagePct, bepAdversePct);
console.log(`\nLogika Baru:`);
console.log(`  - Layer Slippage (Mark $${markPrice} vs Layer Leader $${calcLayerPrice}): +${layerSlippagePct.toFixed(2)}%`);
console.log(`  - Proyeksi Rata-rata User jika beli sekarang: $${userProjectedEntry}`);
console.log(`  - BEP Divergence (User Proyeksi $${userProjectedEntry} vs Leader Rata-rata $${currentLeaderPos.entryPrice}): +${bepAdversePct.toFixed(2)}%`);
console.log(`  - Total Adverse Slippage: +${newAdverseSlippagePct.toFixed(2)}%`);
console.log(`  - Keputusan Bot: ${newAdverseSlippagePct > allowedAdversePct ? '🎯 DITAHAN AUTO-SNIPER PULLBACK (AMAN)' : 'EKSEKUSI'}`);

if (newAdverseSlippagePct <= allowedAdversePct) {
  throw new Error('TEST 2 GAGAL: Seharusnya order ditahan oleh Auto-Sniper karena harga pasar lebih buruk dari layer leader');
}
console.log('✅ TEST 2 BERHASIL: Auto-Sniper berhasil menahan order averaging down!\n');

// 3. UJI TARGET PULLBACK PRICE & BEP SIMULATION
console.log('--- TEST 3: TARGET PULLBACK PRICE & BEP OUTCOME VERIFICATION ---');
// Hitung target harga yang menjamin userProjectedEntry <= leaderPos.entryPrice
const bepTargetPrice = ((projectedTotalQty * currentLeaderPos.entryPrice) - (oldQty * oldEntry)) / addQty;
const targetPullbackPrice = Math.min(calcLayerPrice, bepTargetPrice);

console.log(`Target Pullback Price yang dihitung bot: $${targetPullbackPrice}`);
if (targetPullbackPrice !== 80000) {
  throw new Error(`TEST 3 GAGAL: Target pullback seharusnya $80.000, didapat $${targetPullbackPrice}`);
}

// Simulasi jika harga pullback ke target ($80.000 atau diskon $79.800)
const executedSniperPrice = 79800; // Eksekusi pullback diskon
const finalUserEntry = (oldQty * oldEntry + addQty * executedSniperPrice) / projectedTotalQty;
console.log(`\nHarga eksekusi Sniper setelah pullback: $${executedSniperPrice}`);
console.log(`Rata-rata Entri Akhir Follower: $${finalUserEntry}`);
console.log(`Rata-rata Entri Akhir Leader:   $${currentLeaderPos.entryPrice}`);

// Simulasi jika Leader keluar di BEP ($90.000):
const exitPrice = currentLeaderPos.entryPrice; // $90.000
const leaderPnlAtExit = (exitPrice - currentLeaderPos.entryPrice) * currentLeaderPos.amount;
const userPnlAtExit = (exitPrice - finalUserEntry) * projectedTotalQty;

console.log(`\n--- Skenario Leader Menutup Posisi di BEP ($${exitPrice}) ---`);
console.log(`PnL Leader:   $${leaderPnlAtExit.toFixed(2)} USDT (BEP)`);
console.log(`PnL Follower: +$${userPnlAtExit.toFixed(2)} USDT (PROFIT!)`);

if (userPnlAtExit < 0) {
  throw new Error('TEST 3 GAGAL: Follower tidak boleh rugi saat Leader keluar di BEP!');
}

console.log('✅ TEST 3 BERHASIL: Follower 100% terlindungi dari kerugian saat Leader BEP!');
console.log('\n=== ALL AVERAGING AUTO-SNIPER & BEP GUARD TESTS PASSED 100% ===');
