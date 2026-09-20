import axios from 'axios';

async function testParams() {
  const portfolioId = '5154344801714752768';
  const baseUrl = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade';

  const testUrls = [
    `/lead-data/positions?portfolioId=${portfolioId}`,
    `/lead-data/positions?portfolioId=${portfolioId}&showZero=false`,
    `/lead-data/positions?portfolioId=${portfolioId}&hasPosition=true`,
    `/lead-data/positions?portfolioId=${portfolioId}&status=OPEN`,
    `/lead-data/positions?portfolioId=${portfolioId}&activeOnly=true`,
    `/lead-portfolio/positions?portfolioId=${portfolioId}`,
    `/lead-portfolio/order-history?portfolioId=${portfolioId}&pageSize=10`,
  ];

  for (const path of testUrls) {
    try {
      const res = await axios.get(`${baseUrl}${path}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0 Safari/537.36',
          'clienttype': 'web',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        timeout: 10000,
      });
      const dataLen = Array.isArray(res.data?.data) ? res.data.data.length : (res.data?.data?.list ? res.data.data.list.length : 0);
      const strLen = JSON.stringify(res.data).length;
      console.log(`[GET] ${path}`);
      console.log(`  -> Code: ${res.data?.code}, Items: ${dataLen}, Raw String Length: ${strLen} bytes (${(strLen / 1024).toFixed(1)} KB)`);
    } catch (e: any) {
      console.log(`[GET] ${path} -> Error: ${e.response?.status || e.message}`);
    }
  }
}

testParams();
