# Binance Copy Trader - Standalone Engine & Web Dashboard

Aplikasi mandiri (**standalone**) untuk meng-copy transaksi *Lead Trader* Binance Futures secara otomatis berbasis rasio portofolio dengan dukungan **Residential Proxy** anti-blokir Cloudflare/WAF dan **Web Dashboard Real-Time**.

---

## 🚀 Fitur Utama

- 🔄 **Autonomous Delta Tracking:** Mendeteksi posisi baru (*Open*), penambahan posisi (*Averaging/DCA*), penutupan bertahap (*Partial Close*), hingga penutupan total (*Full Close*).
- 🛡️ **Residential Proxy Ready:** Mendukung rotasi proxy HTTP/SOCKS5 berautentikasi (DataImpulse, Webshare, IPRoyal) untuk menghindari limit dan blokir IP dari Cloudflare Binance saat berjalan 24/7 di VPS.
- 📐 **Ratio-Based Sizing:** Mendukung 3 mode kalkulasi:
  - **`RATIO_EQUITY`**: Proporsional saldo Anda terhadap saldo Leader.
  - **`FIXED_AMOUNT`**: Nominal tetap per posisi dalam USDT.
  - **`FIXED_RATIO`**: Persentase tetap dari saldo per posisi.
- ⚡ **Precision & Safety Guards:**
  - **Safety Cap:** Batas maksimal margin per koin agar akun Anda tidak kehabisan margin jika leader melakukan averaging ekstrem.
  - **Slippage Guard:** Membatalkan order jika harga pasar sudah menyimpang terlalu jauh dari harga entry leader.
  - **Emergency Stop Loss:** Cut loss otomatis independen jika drawdown akun mencapai batas toleransi.
  - **Lot Size & Min Notional:** Normalisasi presisi lot (`stepSize`) dan validasi minimum order Binance ($5 USDT).
- 📊 **Cyberpunk Web Dashboard (Port 5000):**
  - Monitor statistik profil Leader secara real-time.
  - Tabel perbandingan langsung: Posisi Leader vs Posisi Akun Anda.
  - Live Matrix Terminal Log via WebSocket.
  - Tombol Darurat **Panic Close All**.

---

## 🛠️ Cara Menjalankan Aplikasi

### 1. Masuk ke Direktori Proyek
Buka terminal dan arahkan ke folder proyek:
```bash
cd "c:\Office\zaky\project trading ai\binance-copy-trader"
# atau dari trading-front:
cd "c:\Office\zaky\project trading ai\trading-front\copy-trader"
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Jalankan Mode Development
```bash
npm run dev
```

Server dan Web Dashboard akan aktif di:
👉 **`http://localhost:5000`**

### 4. Menjalankan di Server VPS (Production)
```bash
# Build TypeScript ke JavaScript
npm run build

# Jalankan daemon (dapat menggunakan PM2 agar berjalan di background 24/7)
npm install -g pm2
pm2 start dist/server.js --name "binance-copy-trader"
pm2 save
```

---

## 🌐 Cara Setup Residential Proxy (DataImpulse)

1. Daftar akun di **[DataImpulse](https://dataimpulse.com)**.
2. Lakukan deposit minimal **$5** (sistem pay-as-you-go $1.00/GB, kuota tidak pernah kedaluwarsa).
3. Buka menu **Residential Proxies** dan salin:
   - **Host:** `geo.dataimpulse.com` (atau endpoint yang diberikan)
   - **Port:** `823`
   - **Username:** `username_anda`
   - **Password:** `password_anda`
4. Buka Web Dashboard di `http://localhost:5000` $\rightarrow$ klik tombol **Pengaturan** $\rightarrow$ centang **Aktifkan Residential Proxy** $\rightarrow$ masukkan kredensial $\rightarrow$ klik **Uji Koneksi Proxy**.

---

## ⚙️ Konfigurasi (`config.json`)

Konfigurasi dapat diubah langsung melalui antarmuka Web Dashboard atau melalui file `config.json`:

```json
{
  "portfolioId": "5154344801714752768",
  "copyTradeActive": false,
  "binanceApiKey": "API_KEY_ANDA",
  "binanceSecretKey": "SECRET_KEY_ANDA",
  "isTestnet": false,
  "mode": "RATIO_EQUITY",
  "ratioMultiplier": 1.0,
  "fixedAmountUsdt": 25.0,
  "maxModalPerCoin": 50.0,
  "maxSlippagePct": 0.5,
  "syncLeverage": true,
  "emergencySlPct": 10.0,
  "pollingIntervalMs": 2500,
  "proxy": {
    "enabled": false,
    "host": "",
    "port": 823,
    "username": "",
    "password": ""
  }
}
```

---

## 📄 Lisensi
MIT License © 2026 Binance Copy Trader
