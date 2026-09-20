import fs from 'fs';
import { scraper } from '../src/services/scraper';

async function testLeader() {
  const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  console.log(`Portfolio ID: ${cfg.portfolioId}`);
  console.log(`Proxy enabled: ${cfg.proxy?.enabled}, host: ${cfg.proxy?.host}`);

  try {
    const detail = await scraper.fetchPortfolioDetail(cfg.portfolioId, cfg.proxy);
    console.log(`Leader: ${detail.nickname}`);
    console.log(`Position Show: ${detail.positionShow}`);
    console.log(`Total Positions in array: ${detail.positions.length}`);
    console.log(`Total Orders in array: ${detail.orders.length}`);
  } catch (err: any) {
    console.log('Error:', err.message);
  }
}

testLeader();
