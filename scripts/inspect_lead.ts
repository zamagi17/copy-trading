import fs from 'fs';
import { scraper } from '../src/services/scraper';

async function testLeader(portfolioId?: string) {
  const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  const targetId = portfolioId || '4908633203782592768';
  console.log(`Portfolio ID: ${targetId}`);
  console.log(`Proxy enabled: ${cfg.proxy?.enabled}, host: ${cfg.proxy?.host}`);

  try {
    const detail = await scraper.fetchPortfolioDetail(targetId, cfg.proxy);
    console.log(`Leader: ${detail.nickname}`);
    console.log(`Position Show: ${detail.positionShow}`);
    console.log(`Total Positions in array: ${detail.positions?.length || 0}`);
    console.log(`Total Orders in array: ${detail.orders?.length || 0}`);
    if (detail.orders && detail.orders.length > 0) {
      console.log(`First 3 Orders:`);
      for (const ord of detail.orders.slice(0, 3)) {
        console.log(`- [${ord.action}] ${ord.symbol} (${ord.positionSide}) Qty: ${ord.executedQty} Price: ${ord.avgPrice} PnL: ${ord.totalPnl} Time: ${new Date(ord.orderTime).toISOString()}`);
      }
    }
  } catch (err: any) {
    console.log('Error:', err.message);
  }
}

testLeader();
