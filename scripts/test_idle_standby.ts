import { CopyTradeEngine } from '../src/services/engine';

async function testIdleStandby() {
  console.log('=== TEST: Smart Zero-Position Idle Standby ===');

  const engine = new CopyTradeEngine();

  // Disable weekendBreak to simulate weekday behavior
  (engine as any).config.weekendBreak.enabled = false;

  // Test Case 1: Weekday 0 Leader & 0 User positions (Standby should be TRUE @ 5000ms)
  const poll0 = engine.getCurrentPollingInfo(0, 0);
  console.log('1. Weekday Standby state (0 Leader, 0 User):', {
    isIdleStandby: poll0.isIdleStandby,
    sessionKey: poll0.sessionKey,
    sessionName: poll0.sessionName,
    currentIntervalMs: poll0.currentIntervalMs,
  });
  if (!poll0.isIdleStandby || poll0.currentIntervalMs !== 5000) {
    throw new Error(`Expected idle standby at 5000ms, got: ${poll0.currentIntervalMs}ms (isIdleStandby: ${poll0.isIdleStandby})`);
  }

  // Test Case 2: Leader opens 1 position (Standby should immediately deactivate!)
  const poll1 = engine.getCurrentPollingInfo(1, 0);
  console.log('2. Active trade state (1 Leader, 0 User):', {
    isIdleStandby: poll1.isIdleStandby,
    sessionKey: poll1.sessionKey,
    sessionName: poll1.sessionName,
    currentIntervalMs: poll1.currentIntervalMs,
  });
  if (poll1.isIdleStandby || poll1.currentIntervalMs > 3000) {
    throw new Error(`Expected active polling (< 3000ms), got: ${poll1.currentIntervalMs}ms (isIdleStandby: ${poll1.isIdleStandby})`);
  }

  // Test Case 3: User has 1 position open (Guarding mode, Standby should be FALSE)
  const poll2 = engine.getCurrentPollingInfo(0, 1);
  console.log('3. Guarding state (0 Leader, 1 User):', {
    isIdleStandby: poll2.isIdleStandby,
    sessionKey: poll2.sessionKey,
    sessionName: poll2.sessionName,
    currentIntervalMs: poll2.currentIntervalMs,
  });
  if (poll2.isIdleStandby) {
    throw new Error(`Expected standby to be FALSE when user has open positions!`);
  }

  // Test Case 4: Custom idle interval (e.g. 8.0 seconds)
  const customConfig = engine.normalizeConfig({
    weekendBreak: { enabled: false, timezone: 'WIB', standbyIntervalSec: 60, blockNewTrades: true, smartReEntryEnabled: true, reEntryWindowMinutes: 30, autoAbortOnLeaderTrade: true },
    idleStandby: {
      enabled: true,
      idleIntervalSec: 8.0,
    },
  });
  (engine as any).config = customConfig;
  const pollCustom = engine.getCurrentPollingInfo(0, 0);
  console.log('4. Custom 8.0s idle interval state:', {
    isIdleStandby: pollCustom.isIdleStandby,
    sessionKey: pollCustom.sessionKey,
    currentIntervalMs: pollCustom.currentIntervalMs,
  });
  if (pollCustom.currentIntervalMs !== 8000) {
    throw new Error(`Expected 8000ms, got: ${pollCustom.currentIntervalMs}`);
  }

  // Test Case 5: Disabled idle standby
  const disabledConfig = engine.normalizeConfig({
    weekendBreak: { enabled: false, timezone: 'WIB', standbyIntervalSec: 60, blockNewTrades: true, smartReEntryEnabled: true, reEntryWindowMinutes: 30, autoAbortOnLeaderTrade: true },
    idleStandby: {
      enabled: false,
      idleIntervalSec: 5.0,
    },
  });
  (engine as any).config = disabledConfig;
  const pollDisabled = engine.getCurrentPollingInfo(0, 0);
  console.log('5. Disabled idle standby state:', {
    isIdleStandby: pollDisabled.isIdleStandby,
    sessionKey: pollDisabled.sessionKey,
    currentIntervalMs: pollDisabled.currentIntervalMs,
  });
  if (pollDisabled.isIdleStandby) {
    throw new Error(`Expected isIdleStandby to be FALSE when disabled!`);
  }

  // Test Case 6: Weekend Break enabled (Today is Saturday -> 60s Holiday Standby)
  const weekendConfig = engine.normalizeConfig({
    weekendBreak: { enabled: true, timezone: 'WIB', standbyIntervalSec: 60, blockNewTrades: true, smartReEntryEnabled: true, reEntryWindowMinutes: 30, autoAbortOnLeaderTrade: true },
    idleStandby: { enabled: true, idleIntervalSec: 5.0 },
  });
  (engine as any).config = weekendConfig;
  const pollWeekend = engine.getCurrentPollingInfo(0, 0);
  console.log('6. Weekend Break state (Saturday 0 pos):', {
    isWeekendHoliday: pollWeekend.isWeekendHoliday,
    sessionKey: pollWeekend.sessionKey,
    currentIntervalMs: pollWeekend.currentIntervalMs,
  });
  if (!pollWeekend.isWeekendHoliday || pollWeekend.currentIntervalMs !== 60000) {
    throw new Error(`Expected 60000ms weekend standby, got: ${pollWeekend.currentIntervalMs}`);
  }

  console.log('\n✅ ALL 6 IDLE STANDBY & WEEKEND UNIT TESTS PASSED PERFECTLY!');
  process.exit(0);
}

testIdleStandby().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
