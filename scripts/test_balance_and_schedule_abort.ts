import { binanceClient } from '../src/services/binance';
import { CopyTradeEngine } from '../src/services/engine';

async function runTests() {
  console.log('--- TEST 1: BINANCE TIME OFFSET SYNC ---');
  const offset = await binanceClient.syncTime();
  console.log(`Binance Server Time Offset: ${offset} ms`);

  console.log('\n--- TEST 2: BINANCE LIVE BALANCE FETCH ---');
  const engine = new CopyTradeEngine();
  const cfg = engine.getConfig();
  if (cfg.binanceApiKey && cfg.binanceSecretKey) {
    binanceClient.configure(cfg.binanceApiKey, cfg.binanceSecretKey, cfg.isTestnet);
    const balance = await binanceClient.getAccountBalance();
    console.log('Balance Result:', balance);
    console.log(`Total Margin Balance: $${balance.totalMarginBalance}`);
    console.log(`Available Balance: $${balance.availableBalance}`);

    engine.setLastUserAccount(balance, []);
    const cached = engine.getLastUserAccount();
    console.log('Cached Balance in Engine:', cached.balance);
    if (cached.balance && cached.balance.totalMarginBalance > 0) {
      console.log('✅ TEST 2 PASSED: Cached balance properly preserved and non-zero!');
    }
  } else {
    console.log('Binance API key not configured, skipping live API call.');
  }

  console.log('\n--- TEST 3: DAILY SCHEDULE AUTO-ABORT ---');
  // Check daily schedule status
  const schedStatus = engine.getDailyScheduleStatus();
  console.log('Initial Schedule Status:', schedStatus);

  // Trigger abortDailySchedule
  engine.abortDailySchedule('Order baru: BUY BTCUSDT @ $65000', 'Test order stream');
  const abortedStatus = engine.getDailyScheduleStatus();
  console.log('After Abort Status:', {
    isSleeping: abortedStatus.isSleeping,
    isScheduleAborted: abortedStatus.isScheduleAborted,
    abortedReason: abortedStatus.abortedReason,
  });

  if (abortedStatus.isScheduleAborted && !abortedStatus.isSleeping) {
    console.log('✅ TEST 3 PASSED: Schedule auto-abort immediately woke up bot (isSleeping: false, isScheduleAborted: true)!');
  } else {
    console.error('❌ TEST 3 FAILED');
  }

  // Reset abort
  engine.resetDailyScheduleAbort();
  const resetStatus = engine.getDailyScheduleStatus();
  console.log('After Reset Status:', {
    isScheduleAborted: resetStatus.isScheduleAborted,
  });
  if (!resetStatus.isScheduleAborted) {
    console.log('✅ TEST 3 RESET PASSED: Daily schedule abort properly reset!');
  }
}

runTests().catch(console.error);
