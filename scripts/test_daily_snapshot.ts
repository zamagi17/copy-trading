import { engine } from '../src/services/engine';
import { dbService } from '../src/services/db';
import fs from 'fs';
import path from 'path';

async function runTest() {
  console.log('=== TEST DAILY BALANCE SNAPSHOT ===');

  await dbService.init();
  await engine.init();

  const todayWib = engine.getWibDate();
  const yesterdayWib = engine.getYesterdayWibDate();
  console.log(`[Test] Tanggal WIB Hari Ini: ${todayWib}`);
  console.log(`[Test] Tanggal WIB Kemarin : ${yesterdayWib}`);

  if (!todayWib.match(/^\d{4}-\d{2}-\d{2}$/)) {
    throw new Error(`Format todayWib salah: ${todayWib}`);
  }
  if (!yesterdayWib.match(/^\d{4}-\d{2}-\d{2}$/)) {
    throw new Error(`Format yesterdayWib salah: ${yesterdayWib}`);
  }

  // 1. Uji takeDailyBalanceSnapshot()
  console.log('[Test] Mengambil snapshot saldo harian...');
  const snap = await engine.takeDailyBalanceSnapshot(todayWib, false);
  console.log('[Test] Hasil Snapshot:', JSON.stringify(snap, null, 2));

  if (snap.date !== todayWib) {
    throw new Error(`Tanggal snapshot (${snap.date}) tidak cocok dengan target (${todayWib})`);
  }
  if (typeof snap.walletBalance !== 'number') {
    throw new Error('walletBalance harus berupa number');
  }

  // 2. Uji loadDailySnapshots()
  console.log('[Test] Membaca snapshot dari Database / Fallback JSON...');
  const list = await engine.getDailySnapshots(10);
  console.log(`[Test] Ditemukan ${list.length} snapshot harian.`);
  const found = list.find((s) => s.date === todayWib);
  if (!found) {
    throw new Error(`Snapshot tanggal ${todayWib} tidak ditemukan di list!`);
  }
  console.log(`[Test] ✅ Snapshot terverifikasi di database/JSON: Saldo=$${found.walletBalance}, Margin=$${found.marginBalance}`);

  // 3. Periksa file fallback daily_snapshots.json
  const jsonPath = path.resolve(__dirname, '../daily_snapshots.json');
  if (fs.existsSync(jsonPath)) {
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    console.log(`[Test] ✅ File daily_snapshots.json ada dengan ${parsed.length} baris riwayat.`);
  }

  console.log('=== SEMUA TEST SNAPSHOT HARIAN BERHASIL 100% ===');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('[Test Failed]:', err);
  process.exit(1);
});
