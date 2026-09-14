// State variables
const TOKEN_KEY = 'copytrader_jwt_token';
const LANG_KEY = 'copytrader_lang';
const SOUND_KEY = 'copytrader_sound';
let currentLang = localStorage.getItem(LANG_KEY) || 'id';
let isSoundEnabled = localStorage.getItem(SOUND_KEY) !== 'false';
let previousUserPositionsCount = 0;
let ws = null;
let currentConfig = null;
let currentStatus = null;
let isEngineActive = false;
let currentTableTab = 'active';
let closedTradesList = [];
let lastPositionsData = null;
let lastBalanceData = null;
let lastUserPositions = null;

// ==========================================
// I18N DICTIONARY (INDONESIAN & ENGLISH)
// ==========================================
const I18N = {
  id: {
    brand_subtitle: 'Proportional Ratio & Residential Proxy Engine',
    sound_alert_title_on: 'Suara Notifikasi: Aktif (Klik untuk Mematikan)',
    sound_alert_title_off: 'Suara Notifikasi: Senyap (Klik untuk Mengaktifkan)',
    sim_free_trial: 'SIMULASI (FREE TRIAL)',
    sim_testnet: 'BINANCE TESTNET',
    sim_live: 'LIVE BINANCE FUTURES',
    status_standby: 'STANDBY',
    status_running: 'RUNNING',
    status_ip_blocked: 'IP DIBLOKIR (403)',
    status_quota_out: 'KUOTA HABIS (407)',
    btn_start_engine: 'Mulai Copy Trade',
    btn_stop_engine: 'Hentikan Copy Trade',
    btn_panic_close: 'Panic Close All',
    btn_settings: 'Pengaturan',
    btn_logout: 'Logout',
    btn_logout_title: 'Kunci / Logout',

    leader_card_title: 'Target Lead Trader',
    leader_followers_prefix: 'Followers:',
    leader_equity_label: 'Modal/Equity Leader',
    leader_roi_label: 'ROI 7D',
    leader_mdd_label: 'Max Drawdown 7D',

    user_card_title: 'Akun Binance Futures Anda',
    user_mode_sim: 'SIMULASI DEMO',
    user_mode_testnet: 'BINANCE TESTNET',
    user_mode_live: 'LIVE FUTURES',
    user_balance_label: 'Total Saldo Margin',
    user_available_label: 'Saldo Tersedia',
    user_unrealized_label: 'Unrealized PnL',
    user_positions_label: 'Posisi Terbuka',
    user_positions_unit: 'Posisi',

    engine_card_title: 'Status Engine & Proxy',
    proxy_active: 'Proxy: Aktif',
    proxy_disabled: 'Proxy: Nonaktif (Direct DoH)',
    proxy_blocked: 'Proxy: Terblokir (403)',
    proxy_quota_out: 'Proxy: Kuota Habis (407)',
    spec_mode_label: 'Sizing Mode:',
    spec_mode_fixed: 'Tetap',
    spec_mode_ratio_balance: 'Rasio Saldo (5%)',
    spec_mode_ratio_equity: 'Rasio Modal',
    spec_safety_cap_label: 'Safety Cap:',
    spec_slippage_label: 'Slippage Guard:',
    spec_polling_label: 'Polling Jitter:',
    spec_emergency_sl_label: 'Emergency SL:',
    spec_emergency_sl_suffix: '% Cut Loss',
    spec_leverage_label: 'Sync Leverage:',
    spec_leverage_auto: 'Otomatis (Cross)',
    spec_leverage_manual: 'Manual',

    tab_active_positions: 'Posisi Terbuka',
    tab_closed_trades: 'Riwayat Trade Selesai',
    live_indicator: 'Live',
    refresh_tooltip: 'Segarkan Data',
    clear_history_tooltip: 'Bersihkan Riwayat Trade Selesai',

    th_symbol_side: 'Simbol & Arah',
    th_leader_pos: 'Posisi Leader',
    th_leader_entry: 'Entry Leader',
    th_user_pos: 'Posisi Akun Anda',
    th_user_entry: 'Entry Anda',
    th_margin_used: 'Margin Terpakai',
    th_ratio: 'Rasio Akun',
    th_floating_pnl: 'Floating PnL',
    th_roi_pct: 'ROI %',
    th_sync_status: 'Status Sinkron',

    th_closed_time: 'Waktu Selesai',
    th_action: 'Aksi',
    th_qty: 'Volume',
    th_entry_price: 'Harga Beli',
    th_close_price: 'Harga Jual',
    th_realized_pnl: 'Realized PnL',
    th_roi_pnl_pct: 'ROI / PnL %',
    th_account_type: 'Tipe Akun',

    hist_total_closed: 'Total Selesai',
    hist_win_rate: 'Win Rate',
    hist_accum_pnl: 'Akumulasi PnL',
    hist_win_loss: 'Menang / Kalah',

    empty_open_title: 'Leader saat ini belum memiliki posisi aktif yang terbuka.',
    empty_open_desc: 'Bot akan otomatis membuka posisi begitu mendeteksi transaksi baru dari Leader.',
    empty_private_title: 'Mode Privat Aktif pada Leader Ini',
    empty_private_desc: 'Leader menyembunyikan tab Positions dari publik. Bot otomatis membaca stream feed Latest Records dan akan mengeksekusi order begitu Leader bertransaksi.',
    empty_closed_title: 'Belum ada riwayat transaksi yang ditutup.',
    empty_closed_desc: 'Setiap transaksi yang selesai (TP penuh, TP parsial, Cut Loss) akan dicatat rapi di sini.',

    badge_connected: 'TERKONEKSI',
    badge_active_stream: 'AKTIF (STREAM)',
    badge_waiting_close: 'MENUNGGU CLOSE',
    badge_waiting_sync: 'MENUNGGU SINKRON',
    badge_action_full: 'Tutup Penuh',
    badge_action_partial: 'Tutup Parsial',
    badge_action_sl: 'Emergency SL',
    badge_action_panic: 'Panic Close',
    badge_sim: 'Simulasi',
    badge_live: 'Live',

    terminal_title: 'Live Event Terminal Log',
    btn_clear_log: 'Bersihkan Log',
    terminal_init_msg: 'Binance Copy Trader Web Dashboard initialized. Siap memantau aktivitas leader.',

    modal_settings_title: 'Konfigurasi Copy Trading & Proxy',
    legend_sim: 'Mode Simulasi (Paper Trading - Uji Coba Bebas Risiko)',
    check_sim_label: 'Aktifkan Mode Simulasi (Uji Coba 100% GRATIS tanpa uang sungguhan & tanpa resiko)',
    label_sim_balance: 'Saldo Virtual Simulasi (USDT):',
    hint_sim_balance: 'Saldo virtual untuk menguji presisi perhitungan rasio lot dan profit/loss bot.',
    btn_reset_demo: 'Reset & Hapus Riwayat Demo',
    legend_target: 'Target Lead Trader & Sizing',
    label_portfolio_id: 'Portfolio ID Leader Binance:',
    btn_preview_leader: 'Preview',
    hint_portfolio_id: 'ID di URL Binance: binance.com/en/copy-trading/lead-details/',
    label_mode: 'Mode Perhitungan Rasio:',
    opt_mode_equity: 'Rasio Modal (Proporsional Modal Anda / Modal Leader)',
    opt_mode_fixed: 'Nominal Tetap per Koin (USDT)',
    opt_mode_ratio: 'Persentase Tetap dari Saldo (5% per Koin)',
    label_ratio_multiplier: 'Pengali Rasio (Multiplier):',
    hint_ratio_multiplier: 'Default: 1.0 (100% proporsional). Set 0.5 untuk separuh risiko.',
    label_fixed_amount: 'Nominal Tetap per Posisi (USDT):',
    hint_fixed_amount: 'Hanya berlaku jika Mode = Nominal Tetap.',
    label_polling_interval: 'Kecepatan Pantau (Polling Interval):',
    opt_poll_1000: '⚡ 1.0 Detik (Super Cepat / Uji Coba Demo)',
    opt_poll_1500: '⚡ 1.5 Detik (Optimal Seimbang - Rekomendasi)',
    opt_poll_2000: '⚖️ 2.0 Detik (Seimbang & Hemat Kuota Proxy)',
    opt_poll_2500: '🛡️ 2.5 Detik (Standar)',
    opt_poll_3000: '🛡️ 3.0 Detik (Santai / Swing Trading)',
    hint_polling_interval: 'Frekuensi bot mengecek transaksi baru leader ke Binance (dalam milidetik).',
    legend_safety: 'Safety Guard & Manajemen Risiko',
    label_max_modal: 'Safety Cap (Maksimal Margin per Koin USDT):',
    hint_max_modal: 'Mencegah modal habis jika leader melakukan averaging terus-menerus.',
    label_max_slippage: 'Toleransi Slippage Maksimal (%):',
    hint_max_slippage: 'Batalkan order jika harga sudah lari > toleransi dari entry leader.',
    label_emergency_sl: 'Emergency Stop Loss Akun (%):',
    hint_emergency_sl: 'Auto cut-loss independen jika floating minus akun mencapai X%.',
    check_sync_leverage: 'Otomatis Sinkronkan Leverage & Margin Mode Leader (10x/20x Cross)',
    legend_proxy: 'Residential Proxy (Anti Blokir Cloudflare)',
    check_proxy_enable: 'Aktifkan Residential Proxy (Rekomendasi: DataImpulse / Webshare)',
    btn_test_proxy: 'Uji Koneksi Proxy',
    label_proxy_host: 'Proxy Host / IP:',
    placeholder_proxy_host: 'Misal: gw.dataimpulse.com',
    label_proxy_port: 'Port:',
    label_proxy_user: 'Username:',
    placeholder_proxy_user: 'Username proxy',
    label_proxy_pass: 'Password:',
    placeholder_proxy_pass: 'Password proxy',
    legend_api: 'Kredensial Binance Futures API Anda',
    label_api_key: 'Binance API Key:',
    placeholder_api_key: 'Masukkan API Key Binance Futures Anda',
    label_secret_key: 'Binance Secret Key:',
    placeholder_secret_key: 'Masukkan Secret Key Binance Futures Anda',
    check_testnet: 'Gunakan Binance Testnet (Mode Simulasi Demo)',
    legend_security: 'Keamanan & Password Admin',
    label_current_pass: 'Password Admin Saat Ini:',
    placeholder_current_pass: 'Password saat ini',
    label_new_pass: 'Password Baru:',
    placeholder_new_pass: 'Minimal 6 karakter',
    btn_change_pass: 'Ganti Password',
    btn_cancel: 'Batal',
    btn_save_settings: 'Simpan Pengaturan',

    login_title: 'SISTEM TERKUNCI',
    login_desc: 'Masukkan Master Password Admin untuk mengakses bot Binance Copy Trader',
    login_pass_label: 'Master Password Admin:',
    login_pass_placeholder: 'Masukkan password...',
    btn_unlock: 'Buka Dashboard',
    login_hint: 'Password default: admin123 (dapat diubah di menu Pengaturan).',

    alert_pass_empty: 'Harap isi password saat ini dan password baru!',
    alert_pass_min: 'Password baru minimal 6 karakter!',
    alert_pass_success: '✅ Password admin berhasil diperbarui!',
    alert_hist_empty: 'Riwayat transaksi selesai masih kosong.',
    confirm_clear_hist: 'Apakah Anda yakin ingin menghapus seluruh riwayat trade selesai?',
    alert_clear_hist_success: '✅ Riwayat trade selesai berhasil dibersihkan!',
    confirm_panic_close: 'APAKAH ANDA YAKIN?\n\nSemua posisi copy-trade yang sedang terbuka di akun Binance Anda akan ditutup seketika dengan order Market!',
    confirm_reset_demo: 'Apakah Anda yakin ingin menghapus semua riwayat transaksi & posisi virtual demo?',
    alert_reset_demo_success: '✅ Data riwayat demo & posisi virtual telah dibersihkan!',
    alert_test_proxy_need_host: 'Harap masukkan Host dan Port proxy terlebih dahulu sebelum menguji!',
    alert_preview_need_id: 'Masukkan Portfolio ID terlebih dahulu',
    alert_settings_saved: '✅ Pengaturan berhasil disimpan!',

    legend_telegram: 'Notifikasi Bot Telegram ke HP',
    check_telegram_enable: 'Aktifkan Notifikasi Telegram (Kirim alert order buka, TP/SL, dan status proxy ke HP)',
    btn_test_telegram: 'Uji Kirim Pesan Telegram',
    label_telegram_token: 'Telegram Bot Token:',
    placeholder_telegram_token: 'Misal: 7123456789:AAH...',
    hint_telegram_token: 'Dapatkan token bot dari @BotFather di Telegram.',
    label_telegram_chat_id: 'Telegram Chat ID / User ID:',
    placeholder_telegram_chat_id: 'Misal: 123456789',
    hint_telegram_chat_id: 'Ketik /start di @userinfobot untuk melihat Chat ID Anda.',
    alert_test_telegram_need_inputs: 'Harap masukkan Bot Token dan Chat ID terlebih dahulu!',

    check_adaptive_polling: 'Aktifkan Polling Cerdas Berdasarkan Jam WIB (Smart Scheduling)',
    hint_adaptive_polling_intro: 'Secara cerdas menyesuaikan kecepatan polling (1-3 detik) mengikuti kebiasaan buka posisi leader & volatilitas pasar New York/Asia.',
    adaptive_panel_title: 'Jadwal Sesi Pasar WIB (UTC+7)',
    session_dawn_title: 'Dini Hari – Subuh (Sesi New York)',
    session_dawn_desc: 'Paling Agresif (~70% transaksi). Sering buka keranjang 3–5 koin.',
    session_morning_title: 'Pagi Hari (Sesi Asia Tokyo/SG)',
    session_morning_desc: 'Aktivitas Sedang (~15% transaksi). Lebih banyak averaging / tambah muatan.',
    session_afternoon_title: 'Siang – Sore (Sesi Sepi)',
    session_afternoon_desc: 'Paling Sepi (~9% transaksi). Pasar AS tutup. Hemat kuota proxy.',
    session_night_title: 'Malam Hari (Pemanasan New York)',
    session_night_desc: 'Awal Sesi London Sore / Wall Street. Pemanasan sebelum gelombang dini hari.',
    label_session_interval: 'Kecepatan Polling:',
    badge_current_wib: 'Waktu WIB:',
    spec_polling_adaptive_prefix: 'Adaptif WIB',

    legend_weekend_break: 'Opsi Libur Akhir Pekan (Waktu China CST UTC+8)',
    check_weekend_break: 'Aktifkan Libur Sabtu & Minggu (Waktu China CST UTC+8)',
    hint_weekend_break_intro: 'Disesuaikan dengan lead trader China. Libur otomatis berlaku jika tidak ada posisi yang terbuka.',
    weekend_info_explanation: 'Jadwal Libur: Jumat 23:00 WIB (Sabtu 00:00 CST) s/d Minggu 23:00 WIB (Senin 00:00 CST). Aturan Keamanan: Jika akhir pekan tiba namun akun masih memiliki posisi terbuka, bot tetap aktif mengawal hingga posisi tertutup. Begitu bersih (0 posisi), bot otomatis beristirahat & melambatkan polling.',
    label_weekend_standby_interval: 'Interval Standby saat Libur (Hemat Kuota):',
    opt_weekend_30: '⏱️ 30 Detik (Santai)',
    opt_weekend_60: '🛡️ 60 Detik (Optimal Seimbang - Rekomendasi)',
    opt_weekend_120: '🌙 120 Detik (Ultra Hemat Kuota Proxy)',
    hint_weekend_standby_interval: 'Frekuensi heartbeat bot saat libur untuk menghemat kuota proxy dan resource server.',
    check_block_weekend_trades: 'Abaikan Order Baru Leader Selama Akhir Pekan',
    hint_block_weekend_trades: 'Menghindari buka posisi acak saat likuiditas pasar akhir pekan tipis.',
    check_smart_reentry: 'Smart Re-Entry (Toleransi Pemulihan SL)',
    hint_smart_reentry: 'Jika posisi baru tertutup / terkena jarum SL di akhir pekan, izinkan leader membuka kembali koin yang sama untuk recovery.',
    label_reentry_window: 'Jendela Toleransi Waktu Re-Entry:',
    hint_reentry_window: 'Batas waktu leader untuk re-entry recovery sebelum bot mengunci libur penuh.',
    opt_reentry_15: '⚡ 15 Menit',
    opt_reentry_30: '🎯 30 Menit (Optimal Seimbang)',
    opt_reentry_45: '⏳ 45 Menit',
    opt_reentry_60: '🛡️ 60 Menit (Maksimal)',
    status_weekend_reentry: 'TOLERANSI RE-ENTRY',
    spec_weekend_label: 'Libur Akhir Pekan:',
    spec_weekend_active: 'Aktif (Waktu China)',
    spec_weekend_disabled: 'Nonaktif (24/7)',
    status_weekend_holiday: 'LIBUR AKHIR PEKAN (CST)',
    status_weekend_pending: 'MENUNGGU TUTUP POSISI',
    badge_current_cst: 'China CST:',

    btn_test_trade: 'Uji Eksekusi',
    btn_test_trade_title: 'Uji Coba Eksekusi Order',
    test_trade_modal_title: 'Uji Eksekusi Order (Test Trade)',
    test_trade_intro: 'Gunakan fitur ini untuk menguji apakah order berhasil dieksekusi dan masuk ke dalam sistem / Binance secara tepat.',
    label_test_symbol: 'Pilih Simbol Koin:',
    label_test_side: 'Arah Posisi (Side):',
    label_test_amount: 'Nominal Modal Uji Coba (USDT):',
    hint_test_amount: 'Nominal margin USDT untuk membuka posisi uji coba ini.',
    check_bypass_weekend: 'Bypass Libur Akhir Pekan',
    hint_bypass_weekend: 'Jika tidak dicentang, sistem memvalidasi apakah aturan Libur Akhir Pekan CST menolak order saat libur. Jika dicentang, order dipaksa masuk untuk menguji tabel posisi.',
    btn_run_test_trade: 'Eksekusi Order Uji Coba'
  },
  en: {
    brand_subtitle: 'Proportional Ratio & Residential Proxy Engine',
    sound_alert_title_on: 'Sound Notifications: Active (Click to Mute)',
    sound_alert_title_off: 'Sound Notifications: Muted (Click to Unmute)',
    sim_free_trial: 'SIMULATION (FREE TRIAL)',
    sim_testnet: 'BINANCE TESTNET',
    sim_live: 'LIVE BINANCE FUTURES',
    status_standby: 'STANDBY',
    status_running: 'RUNNING',
    status_ip_blocked: 'IP BLOCKED (403)',
    status_quota_out: 'QUOTA EXHAUSTED (407)',
    btn_start_engine: 'Start Copy Trade',
    btn_stop_engine: 'Stop Copy Trade',
    btn_panic_close: 'Panic Close All',
    btn_settings: 'Settings',
    btn_logout: 'Logout',
    btn_logout_title: 'Lock / Logout',

    leader_card_title: 'Target Lead Trader',
    leader_followers_prefix: 'Followers:',
    leader_equity_label: 'Leader Margin/Equity',
    leader_roi_label: 'ROI 7D',
    leader_mdd_label: 'Max Drawdown 7D',

    user_card_title: 'Your Binance Futures Account',
    user_mode_sim: 'DEMO SIMULATION',
    user_mode_testnet: 'BINANCE TESTNET',
    user_mode_live: 'LIVE FUTURES',
    user_balance_label: 'Total Margin Balance',
    user_available_label: 'Available Balance',
    user_unrealized_label: 'Unrealized PnL',
    user_positions_label: 'Open Positions',
    user_positions_unit: 'Positions',

    engine_card_title: 'Engine & Proxy Status',
    proxy_active: 'Proxy: Active',
    proxy_disabled: 'Proxy: Disabled (Direct DoH)',
    proxy_blocked: 'Proxy: Blocked (403)',
    proxy_quota_out: 'Proxy: Quota Out (407)',
    spec_mode_label: 'Sizing Mode:',
    spec_mode_fixed: 'Fixed',
    spec_mode_ratio_balance: 'Balance Ratio (5%)',
    spec_mode_ratio_equity: 'Equity Ratio',
    spec_safety_cap_label: 'Safety Cap:',
    spec_slippage_label: 'Slippage Guard:',
    spec_polling_label: 'Polling Jitter:',
    spec_emergency_sl_label: 'Emergency SL:',
    spec_emergency_sl_suffix: '% Cut Loss',
    spec_leverage_label: 'Sync Leverage:',
    spec_leverage_auto: 'Auto (Cross)',
    spec_leverage_manual: 'Manual',

    tab_active_positions: 'Open Positions',
    tab_closed_trades: 'Closed Trades History',
    live_indicator: 'Live',
    refresh_tooltip: 'Refresh Data',
    clear_history_tooltip: 'Clear Closed Trades History',

    th_symbol_side: 'Symbol & Side',
    th_leader_pos: 'Leader Position',
    th_leader_entry: 'Leader Entry',
    th_user_pos: 'Your Position',
    th_user_entry: 'Your Entry',
    th_margin_used: 'Used Margin',
    th_ratio: 'Account Ratio',
    th_floating_pnl: 'Floating PnL',
    th_roi_pct: 'ROI %',
    th_sync_status: 'Sync Status',

    th_closed_time: 'Closed Time',
    th_action: 'Action',
    th_qty: 'Quantity',
    th_entry_price: 'Entry Price',
    th_close_price: 'Close Price',
    th_realized_pnl: 'Realized PnL',
    th_roi_pnl_pct: 'ROI / PnL %',
    th_account_type: 'Account Type',

    hist_total_closed: 'Total Closed',
    hist_win_rate: 'Win Rate',
    hist_accum_pnl: 'Accumulated PnL',
    hist_win_loss: 'Win / Loss',

    empty_open_title: 'Leader currently has no active open positions.',
    empty_open_desc: 'Bot will automatically mirror positions once the Leader enters a trade.',
    empty_private_title: 'Private Positions Mode Active on This Leader',
    empty_private_desc: 'Leader hides the Positions tab from public. Bot automatically reads the Latest Records stream feed and will execute orders as soon as the Leader trades.',
    empty_closed_title: 'No closed trade records yet.',
    empty_closed_desc: 'Every closed trade (full TP, partial TP, cut loss) will be neatly logged here.',

    badge_connected: 'CONNECTED',
    badge_active_stream: 'ACTIVE (STREAM)',
    badge_waiting_close: 'WAITING CLOSE',
    badge_waiting_sync: 'WAITING SYNC',
    badge_action_full: 'Full Close',
    badge_action_partial: 'Partial Close',
    badge_action_sl: 'Emergency SL',
    badge_action_panic: 'Panic Close',
    badge_sim: 'Simulation',
    badge_live: 'Live',

    terminal_title: 'Live Event Terminal Log',
    btn_clear_log: 'Clear Logs',
    terminal_init_msg: 'Binance Copy Trader Web Dashboard initialized. Ready to track leader activity.',

    modal_settings_title: 'Copy Trading & Proxy Configuration',
    legend_sim: 'Simulation Mode (Paper Trading - Risk-Free Trial)',
    check_sim_label: 'Enable Simulation Mode (100% FREE trial with no real money & zero risk)',
    label_sim_balance: 'Virtual Simulation Balance (USDT):',
    hint_sim_balance: 'Virtual balance to test lot sizing ratio and profit/loss calculations.',
    btn_reset_demo: 'Reset & Clear Demo History',
    legend_target: 'Target Lead Trader & Sizing',
    label_portfolio_id: 'Binance Leader Portfolio ID:',
    btn_preview_leader: 'Preview',
    hint_portfolio_id: 'ID in Binance URL: binance.com/en/copy-trading/lead-details/',
    label_mode: 'Position Sizing Mode:',
    opt_mode_equity: 'Equity Ratio (Proportional User Balance / Leader Equity)',
    opt_mode_fixed: 'Fixed Amount per Coin (USDT)',
    opt_mode_ratio: 'Fixed Balance Ratio (5% per Coin)',
    label_ratio_multiplier: 'Ratio Multiplier:',
    hint_ratio_multiplier: 'Default: 1.0 (100% proportional). Set 0.5 for half risk.',
    label_fixed_amount: 'Fixed Amount per Position (USDT):',
    hint_fixed_amount: 'Only applies when Sizing Mode = Fixed Amount.',
    label_polling_interval: 'Polling Speed (Refresh Rate):',
    opt_poll_1000: '⚡ 1.0 Second (Super Fast / Demo Test)',
    opt_poll_1500: '⚡ 1.5 Seconds (Optimal Balance - Recommended)',
    opt_poll_2000: '⚖️ 2.0 Seconds (Balanced & Proxy Quota Saver)',
    opt_poll_2500: '🛡️ 2.5 Seconds (Standard)',
    opt_poll_3000: '🛡️ 3.0 Seconds (Relaxed / Swing Trading)',
    hint_polling_interval: 'Frequency bot polls Binance for new leader transactions (in milliseconds).',
    legend_safety: 'Safety Guard & Risk Management',
    label_max_modal: 'Safety Cap (Max Margin per Coin USDT):',
    hint_max_modal: 'Prevents account wipeout if leader aggressively averages down.',
    label_max_slippage: 'Max Slippage Tolerance (%):',
    hint_max_slippage: 'Cancel order if market price deviates > tolerance from leader entry.',
    label_emergency_sl: 'Account Emergency Stop Loss (%):',
    hint_emergency_sl: 'Independent auto cut-loss if account floating loss reaches X%.',
    check_sync_leverage: 'Auto Sync Leader Leverage & Margin Mode (10x/20x Cross)',
    legend_proxy: 'Residential Proxy (Cloudflare Bypass)',
    check_proxy_enable: 'Enable Residential Proxy (Recommended: DataImpulse / Webshare)',
    btn_test_proxy: 'Test Proxy Connection',
    label_proxy_host: 'Proxy Host / IP:',
    placeholder_proxy_host: 'e.g. gw.dataimpulse.com',
    label_proxy_port: 'Port:',
    label_proxy_user: 'Username:',
    placeholder_proxy_user: 'Proxy username',
    label_proxy_pass: 'Password:',
    placeholder_proxy_pass: 'Proxy password',
    legend_api: 'Your Binance Futures API Credentials',
    label_api_key: 'Binance API Key:',
    placeholder_api_key: 'Enter your Binance Futures API Key',
    label_secret_key: 'Binance Secret Key:',
    placeholder_secret_key: 'Enter your Binance Futures Secret Key',
    check_testnet: 'Use Binance Testnet (Demo Simulation Mode)',
    legend_security: 'Admin Security & Password',
    label_current_pass: 'Current Admin Password:',
    placeholder_current_pass: 'Current password',
    label_new_pass: 'New Password:',
    placeholder_new_pass: 'Minimum 6 characters',
    btn_change_pass: 'Change Password',
    btn_cancel: 'Cancel',
    btn_save_settings: 'Save Settings',

    login_title: 'SYSTEM LOCKED',
    login_desc: 'Enter Master Admin Password to access Binance Copy Trader bot',
    login_pass_label: 'Master Admin Password:',
    login_pass_placeholder: 'Enter password...',
    btn_unlock: 'Unlock Dashboard',
    login_hint: 'Default password: admin123 (can be changed in Settings).',

    alert_pass_empty: 'Please fill in both current and new password!',
    alert_pass_min: 'New password must be at least 6 characters!',
    alert_pass_success: '✅ Admin password successfully updated!',
    alert_hist_empty: 'Closed trade history is still empty.',
    confirm_clear_hist: 'Are you sure you want to clear all closed trade history?',
    alert_clear_hist_success: '✅ Closed trade history successfully cleared!',
    confirm_panic_close: 'ARE YOU SURE?\n\nAll open copy-trade positions on your Binance account will be immediately closed with Market orders!',
    confirm_reset_demo: 'Are you sure you want to delete all demo trade history & virtual positions?',
    alert_reset_demo_success: '✅ Demo history & virtual positions cleared successfully!',
    alert_test_proxy_need_host: 'Please enter proxy Host and Port before testing!',
    alert_preview_need_id: 'Please enter Portfolio ID first',
    alert_settings_saved: '✅ Settings saved successfully!',

    legend_telegram: 'Telegram Bot Notifications to Smartphone',
    check_telegram_enable: 'Enable Telegram Notifications (Sends open/close orders, TP/SL, & proxy alerts to phone)',
    btn_test_telegram: 'Test Telegram Message',
    label_telegram_token: 'Telegram Bot Token:',
    placeholder_telegram_token: 'e.g. 7123456789:AAH...',
    hint_telegram_token: 'Get your bot token from @BotFather on Telegram.',
    label_telegram_chat_id: 'Telegram Chat ID / User ID:',
    placeholder_telegram_chat_id: 'e.g. 123456789',
    hint_telegram_chat_id: 'Type /start at @userinfobot to find your Chat ID.',
    alert_test_telegram_need_inputs: 'Please enter Bot Token and Chat ID before testing!',

    check_adaptive_polling: 'Enable Smart Adaptive Polling by WIB Hours (Smart Scheduling)',
    hint_adaptive_polling_intro: 'Intelligently adapts polling speed (1-3s) based on leader trade patterns & New York/Asia session volatility.',
    adaptive_panel_title: 'WIB Market Session Schedule (UTC+7)',
    session_dawn_title: 'Dawn – Early Morning (New York Session)',
    session_dawn_desc: 'Most Aggressive (~70% trades). Frequently opens 3–5 coins simultaneously.',
    session_morning_title: 'Morning (Asia Session Tokyo/SG)',
    session_morning_desc: 'Moderate (~15% trades). Averaging and increasing position weights.',
    session_afternoon_title: 'Afternoon (Quiet Session)',
    session_afternoon_desc: 'Quiet (~9% trades). US markets closed. Saves proxy bandwidth.',
    session_night_title: 'Night (New York Warmup)',
    session_night_desc: 'Late London / Wall Street opening. Warmup before late-night rush.',
    label_session_interval: 'Polling Speed:',
    badge_current_wib: 'Current WIB Time:',
    spec_polling_adaptive_prefix: 'Adaptive WIB',

    legend_weekend_break: 'Weekend Holiday Mode (China CST Time UTC+8)',
    check_weekend_break: 'Enable Saturday & Sunday Holiday (China CST Time UTC+8)',
    hint_weekend_break_intro: 'Synchronized with China lead traders. Automatically pauses only when there are NO open positions.',
    weekend_info_explanation: 'Holiday Schedule: Friday 23:00 WIB (Saturday 00:00 CST) until Sunday 23:00 WIB (Monday 00:00 CST). Safety Rule: If positions are still open during the weekend, the bot remains active to guard them until closed. Once clear (0 positions), it enters holiday standby and slows polling.',
    label_weekend_standby_interval: 'Standby Polling Interval during Holiday:',
    opt_weekend_30: '⏱️ 30 Seconds (Relaxed)',
    opt_weekend_60: '🛡️ 60 Seconds (Optimal Balance - Recommended)',
    opt_weekend_120: '🌙 120 Seconds (Ultra Bandwidth Saver)',
    hint_weekend_standby_interval: 'Heartbeat interval during holiday to save residential proxy quota and server resources.',
    check_block_weekend_trades: 'Ignore New Leader Orders During Weekend',
    hint_block_weekend_trades: 'Avoids entering erratic weekend trades when market liquidity is low.',
    check_smart_reentry: 'Smart Re-Entry (SL Recovery Tolerance)',
    hint_smart_reentry: 'If a position just closed or got stopped out on weekends, allow leader to re-enter the same coin for recovery.',
    label_reentry_window: 'Re-Entry Tolerance Grace Window:',
    hint_reentry_window: 'Maximum grace time for leader to re-enter recovery trade before full holiday lockdown.',
    opt_reentry_15: '⚡ 15 Minutes',
    opt_reentry_30: '🎯 30 Minutes (Optimal Balance)',
    opt_reentry_45: '⏳ 45 Minutes',
    opt_reentry_60: '🛡️ 60 Minutes (Maximum)',
    status_weekend_reentry: 'RE-ENTRY GRACE PERIOD',
    spec_weekend_label: 'Weekend Holiday:',
    spec_weekend_active: 'Active (China Time)',
    spec_weekend_disabled: 'Disabled (24/7)',
    status_weekend_holiday: 'WEEKEND HOLIDAY (CST)',
    status_weekend_pending: 'WAITING POSITION CLOSE',
    badge_current_cst: 'China CST Time:',

    btn_test_trade: 'Test Trade',
    btn_test_trade_title: 'Test Order Execution',
    test_trade_modal_title: 'Test Order Execution (Test Trade)',
    test_trade_intro: 'Use this feature to test whether orders execute and enter the system / Binance properly.',
    label_test_symbol: 'Select Coin Symbol:',
    label_test_side: 'Position Side:',
    label_test_amount: 'Test Margin Amount (USDT):',
    hint_test_amount: 'USDT margin amount to open this test position.',
    check_bypass_weekend: 'Bypass Weekend Holiday',
    hint_bypass_weekend: 'If unchecked, tests whether the China CST weekend holiday rule blocks orders during weekend. If checked, forces order entry to test the position table.',
    btn_run_test_trade: 'Execute Test Order'
  }
};

function t(key, fallback = '') {
  return I18N[currentLang]?.[key] || fallback || key;
}

function toggleLanguage() {
  currentLang = currentLang === 'id' ? 'en' : 'id';
  localStorage.setItem(LANG_KEY, currentLang);
  applyLanguage(currentLang);
}

function applyLanguage(lang) {
  document.documentElement.lang = lang;

  // Update navbar switch badges
  const badgeId = document.getElementById('langBadgeId');
  const badgeEn = document.getElementById('langBadgeEn');
  if (badgeId && badgeEn) {
    if (lang === 'id') {
      badgeId.classList.add('active');
      badgeEn.classList.remove('active');
    } else {
      badgeEn.classList.add('active');
      badgeId.classList.remove('active');
    }
  }

  // Update elements with data-i18n
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (I18N[lang] && I18N[lang][key] !== undefined) {
      el.innerText = I18N[lang][key];
    }
  });

  // Update elements with data-i18n-placeholder
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (I18N[lang] && I18N[lang][key] !== undefined) {
      el.setAttribute('placeholder', I18N[lang][key]);
    }
  });

  // Update elements with data-i18n-title
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (I18N[lang] && I18N[lang][key] !== undefined) {
      el.setAttribute('title', I18N[lang][key]);
    }
  });

  // Re-render active UI sections with translated strings
  if (currentStatus) updateEngineUI(currentStatus);
  if (currentConfig) updateConfigSpecs(currentConfig);
  if (lastBalanceData !== null || lastUserPositions !== null) {
    updateUserAccountUI(lastBalanceData, lastUserPositions);
  }
  if (lastPositionsData) {
    renderPositionsTable(lastPositionsData.leaderPositions, lastPositionsData.userPositions, lastPositionsData.orders, lastPositionsData.positionShow);
  }
  if (currentTableTab === 'closed') {
    renderClosedTradesTable();
  }
  initSoundUI();
}

// ==========================================
// WEB AUDIO SOUND ALERT SYNTHESIZER
// ==========================================
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playTone(freq, type = 'sine', duration = 0.15, startTime = 0, gainLevel = 0.1) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + startTime);

    gain.gain.setValueAtTime(gainLevel, ctx.currentTime + startTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(ctx.currentTime + startTime);
    osc.stop(ctx.currentTime + startTime + duration);
  } catch (e) {}
}

function playSound(soundType) {
  if (!isSoundEnabled) return;
  try {
    if (soundType === 'open') {
      // Pleasant bright pluck chord (C5 523Hz + G5 784Hz)
      playTone(523.25, 'sine', 0.18, 0, 0.12);
      playTone(783.99, 'triangle', 0.22, 0.06, 0.10);
    } else if (soundType === 'win') {
      // Victory ascending chime (C5 -> E5 -> G5 -> C6)
      playTone(523.25, 'triangle', 0.14, 0, 0.12);
      playTone(659.25, 'triangle', 0.14, 0.08, 0.12);
      playTone(783.99, 'triangle', 0.16, 0.16, 0.14);
      playTone(1046.50, 'sine', 0.35, 0.24, 0.15);
    } else if (soundType === 'loss') {
      // Soft minor alert (E4 329Hz -> C4 261Hz)
      playTone(329.63, 'sine', 0.20, 0, 0.10);
      playTone(261.63, 'sine', 0.30, 0.12, 0.09);
    } else if (soundType === 'alert') {
      // Urgent double beep (A5 880Hz)
      playTone(880, 'square', 0.08, 0, 0.08);
      playTone(880, 'square', 0.08, 0.12, 0.08);
    }
  } catch (e) {}
}

function initSoundUI() {
  const box = document.getElementById('soundToggleBox');
  const icon = document.getElementById('soundToggleIcon');
  if (!box || !icon) return;

  if (isSoundEnabled) {
    box.classList.remove('muted');
    box.title = t('sound_alert_title_on', 'Suara Notifikasi: Aktif (Klik untuk Mematikan)');
    icon.setAttribute('data-lucide', 'bell');
  } else {
    box.classList.add('muted');
    box.title = t('sound_alert_title_off', 'Suara Notifikasi: Senyap (Klik untuk Mengaktifkan)');
    icon.setAttribute('data-lucide', 'bell-off');
  }
  lucide.createIcons({ root: box });
}

function toggleSoundAlert() {
  isSoundEnabled = !isSoundEnabled;
  localStorage.setItem(SOUND_KEY, isSoundEnabled ? 'true' : 'false');
  initSoundUI();
  if (isSoundEnabled) {
    playSound('open');
  }
}

// DOM Elements
const engineStatusBadge = document.getElementById('engineStatusBadge');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const btnToggleEngine = document.getElementById('btnToggleEngine');
const toggleBtnText = document.getElementById('toggleBtnText');
const toggleIcon = document.getElementById('toggleIcon');

// Leader DOMs
const leaderName = document.getElementById('leaderName');
const leaderIdText = document.getElementById('leaderIdText');
const leaderAvatar = document.getElementById('leaderAvatar');
const leaderFollowersBadge = document.getElementById('leaderFollowersBadge');
const leaderEquityVal = document.getElementById('leaderEquityVal');
const leaderRoiVal = document.getElementById('leaderRoiVal');
const leaderMddVal = document.getElementById('leaderMddVal');

// User DOMs
const userWalletBalance = document.getElementById('userWalletBalance');
const userAvailableBalance = document.getElementById('userAvailableBalance');
const userFloatingPnl = document.getElementById('userFloatingPnl');
const userOpenPositionsCount = document.getElementById('userOpenPositionsCount');

// Engine Specs DOMs
const proxyStatusBadge = document.getElementById('proxyStatusBadge');
const specMode = document.getElementById('specMode');
const specSafetyCap = document.getElementById('specSafetyCap');
const specSlippage = document.getElementById('specSlippage');

// Table & Terminal
const positionsTableBody = document.getElementById('positionsTableBody');
const terminalLogBox = document.getElementById('terminalLogBox');
const settingsModal = document.getElementById('settingsModal');
const loginOverlay = document.getElementById('loginOverlay');
const loginPassword = document.getElementById('loginPassword');
const loginErrorMsg = document.getElementById('loginErrorMsg');

const simBadge = document.getElementById('simBadge');
const simBadgeText = document.getElementById('simBadgeText');
const checkPaperTrading = document.getElementById('checkPaperTrading');
const inputVirtualBalance = document.getElementById('inputVirtualBalance');
const inputPortfolioId = document.getElementById('inputPortfolioId');
const selectMode = document.getElementById('selectMode');
const selectPollingInterval = document.getElementById('selectPollingInterval');
const inputRatioMultiplier = document.getElementById('inputRatioMultiplier');
const inputFixedAmount = document.getElementById('inputFixedAmount');
const inputMaxModalPerCoin = document.getElementById('inputMaxModalPerCoin');
const inputMaxSlippage = document.getElementById('inputMaxSlippage');
const inputEmergencySl = document.getElementById('inputEmergencySl');
const checkSyncLeverage = document.getElementById('checkSyncLeverage');
const checkProxyEnabled = document.getElementById('checkProxyEnabled');
const inputProxyHost = document.getElementById('inputProxyHost');
const inputProxyPort = document.getElementById('inputProxyPort');
const inputProxyUser = document.getElementById('inputProxyUser');
const inputProxyPass = document.getElementById('inputProxyPass');
const inputApiKey = document.getElementById('inputApiKey');
const inputSecretKey = document.getElementById('inputSecretKey');
const checkIsTestnet = document.getElementById('checkIsTestnet');
const checkTelegramEnabled = document.getElementById('checkTelegramEnabled');
const inputTelegramToken = document.getElementById('inputTelegramToken');
const inputTelegramChatId = document.getElementById('inputTelegramChatId');
const checkAdaptivePolling = document.getElementById('checkAdaptivePolling');
const staticPollingRow = document.getElementById('staticPollingRow');
const adaptiveSchedulePanel = document.getElementById('adaptiveSchedulePanel');
const selectDawnInterval = document.getElementById('selectDawnInterval');
const selectMorningInterval = document.getElementById('selectMorningInterval');
const selectAfternoonInterval = document.getElementById('selectAfternoonInterval');
const selectNightInterval = document.getElementById('selectNightInterval');
const currentWibBadge = document.getElementById('currentWibBadge');
const cardSessionDawn = document.getElementById('cardSessionDawn');
const cardSessionMorning = document.getElementById('cardSessionMorning');
const cardSessionAfternoon = document.getElementById('cardSessionAfternoon');
const cardSessionNight = document.getElementById('cardSessionNight');
const inputCurrentPass = document.getElementById('inputCurrentPass');
const inputNewPass = document.getElementById('inputNewPass');

// Weekend Holiday DOMs
const holidayBadge = document.getElementById('holidayBadge');
const holidayBadgeText = document.getElementById('holidayBadgeText');
const specWeekendBreak = document.getElementById('specWeekendBreak');
const currentCstBadge = document.getElementById('currentCstBadge');
const checkWeekendBreak = document.getElementById('checkWeekendBreak');
const weekendBreakInputsRow = document.getElementById('weekendBreakInputsRow');
const selectWeekendStandbyInterval = document.getElementById('selectWeekendStandbyInterval');
const checkBlockWeekendNewTrades = document.getElementById('checkBlockWeekendNewTrades');
const checkSmartReEntry = document.getElementById('checkSmartReEntry');
const selectReEntryWindow = document.getElementById('selectReEntryWindow');
const weekendModalCstClock = document.getElementById('weekendModalCstClock');
const weekendModalWibClock = document.getElementById('weekendModalWibClock');
const weekendModalStatusBadge = document.getElementById('weekendModalStatusBadge');

// Test Trade DOMs
const testTradeModal = document.getElementById('testTradeModal');
const selectTestSymbol = document.getElementById('selectTestSymbol');
const selectTestSide = document.getElementById('selectTestSide');
const inputTestAmount = document.getElementById('inputTestAmount');
const checkBypassWeekend = document.getElementById('checkBypassWeekend');
const testTradeAlertBox = document.getElementById('testTradeAlertBox');
const btnExecuteTestTrade = document.getElementById('btnExecuteTestTrade');

// ==========================================
// AUTHENTICATION & API HELPERS
// ==========================================
function getAuthToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function setAuthToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

async function apiFetch(url, options = {}) {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      setAuthToken(null);
      showLoginOverlay();
      throw new Error('Sesi kedaluwarsa atau belum login.');
    }
    return res;
  } catch (err) {
    throw err;
  }
}

function showLoginOverlay() {
  loginOverlay.style.display = 'flex';
  loginPassword.value = '';
  loginErrorMsg.style.display = 'none';
  loginPassword.focus();
}

function hideLoginOverlay() {
  loginOverlay.style.display = 'none';
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const password = loginPassword.value.trim();
  if (!password) return;

  const btn = document.getElementById('btnLoginSubmit');
  btn.disabled = true;
  btn.innerText = 'Memverifikasi...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const data = await res.json();
    if (data.success && data.token) {
      setAuthToken(data.token);
      hideLoginOverlay();
      connectWebSocket();
      fetchInitialData();
    } else {
      loginErrorMsg.innerText = data.message || 'Password salah!';
      loginErrorMsg.style.display = 'block';
    }
  } catch (err) {
    loginErrorMsg.innerText = `Error koneksi: ${err.message}`;
    loginErrorMsg.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="unlock"></i> Buka Dashboard';
    lucide.createIcons();
  }
}

function logout() {
  setAuthToken(null);
  if (ws) {
    ws.close();
    ws = null;
  }
  showLoginOverlay();
}

async function changeAdminPassword() {
  const currentPassword = inputCurrentPass.value.trim();
  const newPassword = inputNewPass.value.trim();

  if (!currentPassword || !newPassword) {
    alert(t('alert_pass_empty', 'Harap isi password saat ini dan password baru!'));
    return;
  }
  if (newPassword.length < 6) {
    alert(t('alert_pass_min', 'Password baru minimal 6 karakter!'));
    return;
  }

  try {
    const res = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (data.success) {
      alert(t('alert_pass_success', '✅ Password admin berhasil diperbarui!'));
      inputCurrentPass.value = '';
      inputNewPass.value = '';
    } else {
      alert(`❌ Gagal: ${data.message}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// ==========================================
// INITIALIZE & WEBSOCKET
// ==========================================
window.addEventListener('DOMContentLoaded', async () => {
  applyLanguage(currentLang);
  initSoundUI();
  const token = getAuthToken();
  if (!token) {
    showLoginOverlay();
    return;
  }

  // Verifikasi token aktif
  try {
    const res = await apiFetch('/api/auth/check');
    if (res.ok) {
      hideLoginOverlay();
      connectWebSocket();
      fetchInitialData();
    } else {
      showLoginOverlay();
    }
  } catch {
    showLoginOverlay();
  }
});

function connectWebSocket() {
  const token = getAuthToken();
  if (!token) return;

  if (ws) {
    try { ws.close(); } catch {}
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}?token=${encodeURIComponent(token)}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    appendLog('SUCCESS', 'WebSocket terhubung ke Copy Trade Engine');
  };

  ws.onmessage = (event) => {
    try {
      const { type, payload } = JSON.parse(event.data);
      if (type === 'INIT') {
        currentConfig = payload.config;
        currentStatus = payload.status;
        updateEngineUI(payload.status);
        updateConfigSpecs(payload.config);
        if (payload.user) {
          previousUserPositionsCount = payload.user.positions ? payload.user.positions.length : 0;
          updateUserAccountUI(payload.user.balance, payload.user.positions);
          if (payload.user.closedTrades) {
            updateClosedTradesUI(payload.user.closedTrades);
          }
        }
        if (payload.leader) {
          updateLeaderUI(payload.leader, payload.user?.positions || []);
        }
        if (payload.logs) {
          payload.logs.reverse().forEach((l) => appendLog(l.level, l.message, l.timestamp));
        }
      } else if (type === 'TICK') {
        updateTickData(payload);
      } else if (type === 'CLOSED_TRADE') {
        closedTradesList.unshift(payload);
        if (closedTradesList.length > 250) closedTradesList.pop();
        updateClosedTradesUI(closedTradesList);
        if (Number(payload.realizedPnl) >= 0) {
          playSound('win');
        } else {
          playSound('loss');
        }
      } else if (type === 'LOG') {
        appendLog(payload.level, payload.message, payload.timestamp);
      } else if (type === 'AUTH_ERROR') {
        logout();
      }
    } catch (e) {
      console.error('Error parse ws data:', e);
    }
  };

  ws.onclose = (e) => {
    if (e.code === 4001) {
      logout();
      return;
    }
    appendLog('WARN', 'WebSocket terputus. Mencoba rekoneksi dalam 3 detik...');
    setTimeout(connectWebSocket, 3000);
  };
}

async function fetchInitialData() {
  try {
    const res = await apiFetch('/api/config');
    currentConfig = await res.json();
    updateConfigSpecs(currentConfig);

    const statusRes = await apiFetch('/api/status');
    const statusData = await statusRes.json();
    currentStatus = statusData.status;
    updateEngineUI(statusData.status);

    if (statusData.leader) {
      updateLeaderUI(statusData.leader, statusData.user?.positions || []);
    }

    if (statusData.user) {
      updateUserAccountUI(statusData.user.balance, statusData.user.positions);
    }

    // Ambil histori trade selesai
    try {
      const closedRes = await apiFetch('/api/closed-trades');
      const closedData = await closedRes.json();
      if (closedData.success && Array.isArray(closedData.trades)) {
        updateClosedTradesUI(closedData.trades);
      }
    } catch {}
  } catch (err) {
    console.error('Gagal memuat data awal:', err);
  }
}

function updateEngineUI(status) {
  isEngineActive = status?.isActive || false;

  if (isEngineActive) {
    if (status?.lastError && (status.lastError.includes('403') || status.lastError.includes('IP_BLOCKED'))) {
      statusDot.className = 'status-dot dot-error';
      statusText.innerText = t('status_ip_blocked', 'IP DIBLOKIR (403)');
      statusText.style.color = 'var(--accent-red)';
    } else if (status?.lastError && (status.lastError.includes('407') || status.lastError.includes('AUTH'))) {
      statusDot.className = 'status-dot dot-error';
      statusText.innerText = t('status_quota_out', 'KUOTA HABIS (407)');
      statusText.style.color = 'var(--accent-red)';
    } else {
      statusDot.className = 'status-dot dot-active';
      statusText.innerText = t('status_running', 'RUNNING');
      statusText.style.color = 'var(--accent-green)';
    }
    btnToggleEngine.className = 'btn btn-danger';
    toggleBtnText.innerText = t('btn_stop_engine', 'Hentikan Copy Trade');
    toggleIcon.setAttribute('data-lucide', 'square');
  } else {
    statusDot.className = 'status-dot dot-idle';
    statusText.innerText = t('status_standby', 'STANDBY');
    statusText.style.color = 'var(--text-muted)';
    btnToggleEngine.className = 'btn btn-success';
    toggleBtnText.innerText = t('btn_start_engine', 'Mulai Copy Trade');
    toggleIcon.setAttribute('data-lucide', 'play');
  }
  lucide.createIcons({ root: btnToggleEngine });

  // Update Weekend Holiday Badge in Header
  if (holidayBadge && status?.weekendBreak) {
    const wb = status.weekendBreak;
    if (wb.isHolidayActive && isEngineActive) {
      holidayBadge.style.display = 'flex';
      holidayBadge.style.background = 'rgba(16, 185, 129, 0.15)';
      holidayBadge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
      holidayBadge.style.color = '#34d399';
      if (holidayBadgeText) holidayBadgeText.innerText = t('status_weekend_holiday', 'LIBUR AKHIR PEKAN (CST)');
      holidayBadge.title = `Mode Libur Aktif (${wb.cstTimeStr}). Standby polling aktif. Buka kembali: ${wb.resumeTimeStr}`;
    } else if (wb.inReEntryWindow && isEngineActive) {
      holidayBadge.style.display = 'flex';
      holidayBadge.style.background = 'rgba(56, 189, 248, 0.15)';
      holidayBadge.style.borderColor = 'rgba(56, 189, 248, 0.4)';
      holidayBadge.style.color = '#38bdf8';
      if (holidayBadgeText) holidayBadgeText.innerText = `🎯 RE-ENTRY GRACE (${wb.reEntryRemainingMins || 30}M)`;
      holidayBadge.title = `Jendela Toleransi Smart Re-Entry Aktif: Bot siaga menangkap re-entry leader dalam ${wb.reEntryRemainingMins} menit ke depan sebelum libur.`;
    } else if (wb.isWeekendCST && wb.hasOpenPositions && isEngineActive) {
      holidayBadge.style.display = 'flex';
      holidayBadge.style.background = 'rgba(234, 179, 8, 0.15)';
      holidayBadge.style.borderColor = 'rgba(234, 179, 8, 0.4)';
      holidayBadge.style.color = '#fde047';
      if (holidayBadgeText) holidayBadgeText.innerText = t('status_weekend_pending', 'MENUNGGU TUTUP POSISI');
      holidayBadge.title = `Akhir pekan Waktu China, bot tetap aktif mengawal posisi terbuka sebelum libur.`;
    } else {
      holidayBadge.style.display = 'none';
    }
  }

  // Update CST clock in schedule panel header
  if (currentCstBadge && status?.weekendBreak?.cstTimeStr) {
    currentCstBadge.innerText = `${t('badge_current_cst', 'China CST:')} ${status.weekendBreak.cstTimeStr}`;
  }

  // Update polling info in UI if available
  if (status?.pollingInfo) {
    const specPolling = document.getElementById('specPolling');
    if (specPolling) {
      const sfx = currentLang === 'en' ? 's' : 'Detik';
      const sec = (status.pollingInfo.currentIntervalMs / 1000).toFixed(1);
      if (status.pollingInfo.isAdaptive) {
        const shortSession = status.pollingInfo.sessionName.split(' ')[0];
        specPolling.innerText = `⚡ ~${sec}${sfx} (${shortSession})`;
        specPolling.title = `Jadwal Sesi Aktif: ${status.pollingInfo.sessionName} (${status.pollingInfo.wibTimeStr}) - Interval: ~${sec} detik`;
      } else {
        specPolling.innerText = `~${sec} ${sfx}`;
        specPolling.title = 'Interval Manual Tetap';
      }
    }
    highlightActiveSession(status.pollingInfo.sessionKey, status.pollingInfo.wibTimeStr);
  }
}

function updateConfigSpecs(cfg) {
  if (!cfg) return;

  // 1. Target Leader ID & Name in Card 1
  if (cfg.portfolioId) {
    if (leaderIdText) leaderIdText.innerText = `Portfolio ID: ${cfg.portfolioId}`;
    if (leaderName && (!leaderName.innerText || leaderName.innerText.startsWith('Leader '))) {
      leaderName.innerText = `Leader ${cfg.portfolioId}`;
    }
  }

  // 2. Mode Sizing Display in Card 3
  if (specMode) {
    if (cfg.mode === 'FIXED_AMOUNT') {
      specMode.innerText = `${t('spec_mode_fixed', 'Tetap')} ($${Number(cfg.fixedAmountUsdt || 25).toFixed(0)} USDT)`;
    } else if (cfg.mode === 'FIXED_RATIO') {
      specMode.innerText = t('spec_mode_ratio_balance', 'Rasio Saldo (5%)');
    } else {
      specMode.innerText = `${t('spec_mode_ratio_equity', 'Rasio Modal')} (${Number(cfg.ratioMultiplier || 1.0).toFixed(1)}x)`;
    }
  }

  // 3. Safety Cap & Slippage Guard
  if (specSafetyCap) specSafetyCap.innerText = `$${Number(cfg.maxModalPerCoin || 50).toFixed(2)} USDT`;
  if (specSlippage) specSlippage.innerText = `${Number(cfg.maxSlippagePct || 0.5).toFixed(2)}% Max`;

  // 4. Polling Jitter Interval
  const specPolling = document.getElementById('specPolling');
  if (specPolling) {
    const sfx = currentLang === 'en' ? 's' : 'Detik';
    if (cfg.adaptivePolling?.enabled) {
      specPolling.innerText = `⚡ ${t('spec_polling_adaptive_prefix', 'Adaptif WIB')}`;
      specPolling.title = 'Jadwal Polling Cerdas Berdasarkan Sesi Pasar WIB Aktif';
    } else {
      specPolling.innerText = `~${((cfg.pollingIntervalMs || 1500) / 1000).toFixed(1)} ${sfx}`;
      specPolling.title = 'Interval Manual Tetap';
    }
  }

  // 5. Emergency Stop Loss
  const specEmergencySl = document.getElementById('specEmergencySl');
  if (specEmergencySl) {
    specEmergencySl.innerText = `${Number(cfg.emergencySlPct || 10).toFixed(0)}${t('spec_emergency_sl_suffix', '% Cut Loss')}`;
  }

  // 6. Leverage Synchronization
  const specLeverageSync = document.getElementById('specLeverageSync');
  if (specLeverageSync) {
    specLeverageSync.innerText = cfg.syncLeverage !== false ? t('spec_leverage_auto', 'Otomatis (Cross)') : t('spec_leverage_manual', 'Manual');
  }

  // 7. Simulation / Live Futures Badges
  const isSim = cfg.paperTrading !== false;
  const accountModeBadge = document.getElementById('accountModeBadge');
  if (accountModeBadge) {
    accountModeBadge.innerText = isSim ? t('user_mode_sim', 'SIMULASI DEMO') : (cfg.isTestnet ? t('user_mode_testnet', 'BINANCE TESTNET') : t('user_mode_live', 'LIVE FUTURES'));
    accountModeBadge.className = `badge ${isSim ? 'badge-purple' : 'badge-cyan'}`;
  }

  if (simBadge && simBadgeText) {
    if (isSim) {
      simBadge.style.background = 'rgba(59, 130, 246, 0.15)';
      simBadge.style.borderColor = 'rgba(59, 130, 246, 0.4)';
      simBadge.style.color = '#60a5fa';
      simBadgeText.innerText = t('sim_free_trial', 'SIMULASI (FREE TRIAL)');
    } else {
      simBadge.style.background = 'rgba(34, 197, 94, 0.15)';
      simBadge.style.borderColor = 'rgba(34, 197, 94, 0.4)';
      simBadge.style.color = '#22c55e';
      simBadgeText.innerText = cfg.isTestnet ? t('sim_testnet', 'BINANCE TESTNET') : t('sim_live', 'LIVE BINANCE FUTURES');
    }
  }

  // 8. Proxy Status Badge
  if (cfg.proxy && cfg.proxy.enabled) {
    if (currentStatus?.lastError && (currentStatus.lastError.includes('403') || currentStatus.lastError.includes('IP_BLOCKED'))) {
      proxyStatusBadge.innerText = t('proxy_blocked', 'Proxy: Terblokir (403)');
      proxyStatusBadge.className = 'badge badge-red';
    } else if (currentStatus?.lastError && (currentStatus.lastError.includes('407') || currentStatus.lastError.includes('AUTH'))) {
      proxyStatusBadge.innerText = t('proxy_quota_out', 'Proxy: Kuota Habis (407)');
      proxyStatusBadge.className = 'badge badge-red';
    } else {
      proxyStatusBadge.innerText = `${t('proxy_active', 'Proxy: Aktif')} (${cfg.proxy.host || 'OK'})`;
      proxyStatusBadge.className = 'badge badge-green';
    }
  } else {
    proxyStatusBadge.innerText = t('proxy_disabled', 'Proxy: Nonaktif (Direct DoH)');
    proxyStatusBadge.className = 'badge badge-purple';
  }

  // 9. Weekend Break Mode Spec
  if (specWeekendBreak) {
    if (cfg.weekendBreak?.enabled !== false) {
      specWeekendBreak.innerText = t('spec_weekend_active', 'Aktif (Waktu China)');
      specWeekendBreak.className = 'spec-value text-green';
    } else {
      specWeekendBreak.innerText = t('spec_weekend_disabled', 'Nonaktif (24/7)');
      specWeekendBreak.className = 'spec-value text-muted';
    }
  }
}

function updateLeaderUI(l, userPositions = []) {
  if (!l) return;
  if (l.nickname && leaderName) leaderName.innerText = l.nickname;
  if (l.totalEquity && leaderEquityVal) leaderEquityVal.innerText = `${formatNumber(l.totalEquity)}`;
  if (l.roi7d !== undefined && leaderRoiVal) {
    leaderRoiVal.innerText = `${Number(l.roi7d) >= 0 ? '+' : ''}${Number(l.roi7d).toFixed(2)}%`;
    leaderRoiVal.className = `metric-val ${Number(l.roi7d) >= 0 ? 'text-green' : 'text-red'}`;
  }
  if (l.mdd7d !== undefined && leaderMddVal) leaderMddVal.innerText = `${Number(l.mdd7d).toFixed(2)}%`;
  if (l.followerCount !== undefined && leaderFollowersBadge) {
    const isFull = l.maxFollowerCount && l.followerCount >= l.maxFollowerCount;
    leaderFollowersBadge.innerText = `Followers: ${l.followerCount} / ${l.maxFollowerCount || 1000}${isFull ? ' (FULL)' : ''}`;
    leaderFollowersBadge.className = `badge ${isFull ? 'badge-yellow' : 'badge-green'}`;
  }
  if (l.avatarUrl && leaderAvatar) {
    leaderAvatar.innerHTML = `<img src="${l.avatarUrl}" alt="${l.nickname || 'Leader'}" style="width: 100%; height: 100%; border-radius: 12px; object-fit: cover;" />`;
  }
  if (Array.isArray(l.positions) || l.positionShow !== undefined) {
    renderPositionsTable(l.positions || [], userPositions, l.orders || [], l.positionShow);
  }
}

function updateTickData(payload) {
  if (payload.status) {
    currentStatus = payload.status;
    updateEngineUI(payload.status);
    if (currentConfig) updateConfigSpecs(currentConfig);
  }

  // Update Leader Card
  if (payload.leader) {
    updateLeaderUI(payload.leader, payload.user?.positions || []);
  }

  // Update User Account
  if (payload.user) {
    const currentPositionsCount = payload.user.positions ? payload.user.positions.length : 0;
    if (currentPositionsCount > previousUserPositionsCount && previousUserPositionsCount > 0) {
      playSound('open');
    }
    previousUserPositionsCount = currentPositionsCount;
    updateUserAccountUI(payload.user.balance, payload.user.positions);
    if (payload.user.closedTrades) {
      updateClosedTradesUI(payload.user.closedTrades);
    }
  }
}

function updateUserAccountUI(balance, positions) {
  lastBalanceData = balance;
  lastUserPositions = positions;
  if (typeof balance === 'number') {
    userWalletBalance.innerHTML = `$${formatNumber(balance)} <span class="currency">USDT</span>`;
    userAvailableBalance.innerText = `$${formatNumber(balance)}`;
    userFloatingPnl.innerText = `$0.00`;
    userFloatingPnl.className = 'metric-val text-muted';
  } else if (balance) {
    const total = balance.totalWalletBalance ?? balance.totalMarginBalance ?? balance.availableBalance ?? 0;
    const avail = balance.availableBalance ?? total;
    userWalletBalance.innerHTML = `$${formatNumber(total)} <span class="currency">USDT</span>`;
    userAvailableBalance.innerText = `$${formatNumber(avail)}`;
    
    const pnl = balance.totalUnrealizedProfit || 0;
    userFloatingPnl.innerText = `${pnl >= 0 ? '+' : ''}$${formatNumber(pnl)}`;
    userFloatingPnl.className = `metric-val ${pnl > 0 ? 'text-green' : pnl < 0 ? 'text-red' : 'text-muted'}`;
  }

  const count = positions ? positions.length : 0;
  userOpenPositionsCount.innerText = `${count} ${t('user_positions_unit', 'Posisi')}`;
  const activeCountBadge = document.getElementById('activeCountBadge');
  if (activeCountBadge) activeCountBadge.innerText = count;
}

function renderPositionsTable(leaderPositions = [], userPositions = [], orders = [], positionShow = true) {
  lastPositionsData = { leaderPositions, userPositions, orders, positionShow };
  const isPrivate = positionShow === false;
  const leaderList = Array.isArray(leaderPositions) ? leaderPositions : [];
  const userList = Array.isArray(userPositions) ? userPositions : [];

  if (leaderList.length === 0 && userList.length === 0) {
    positionsTableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="10">
          <div class="empty-state">
            <i data-lucide="${isPrivate ? 'shield' : 'inbox'}" class="empty-icon ${isPrivate ? 'text-purple' : ''}"></i>
            <p>${isPrivate ? `<b>${t('empty_private_title', 'Mode Privat Aktif pada Leader Ini')}</b>` : t('empty_open_title', 'Leader saat ini belum memiliki posisi aktif yang terbuka.')}</p>
            <small>${isPrivate 
              ? t('empty_private_desc', 'Leader menyembunyikan tab Positions dari publik. <b>Bot otomatis membaca stream feed Latest Records</b> dan akan mengeksekusi order begitu Leader bertransaksi.') 
              : t('empty_open_desc', 'Bot akan otomatis membuka posisi begitu mendeteksi transaksi baru dari Leader.')}</small>
          </div>
        </td>
      </tr>
    `;
    lucide.createIcons({ root: positionsTableBody });
    return;
  }

  const leaderMap = new Map();
  for (const lp of leaderList) {
    leaderMap.set(`${lp.symbol}_${lp.positionSide}`, lp);
  }

  const userMap = new Map();
  for (const up of userList) {
    userMap.set(`${up.symbol}_${up.positionSide}`, up);
  }

  // Gabungkan semua key unik (dari posisi leader dan posisi akun pengguna)
  const allKeys = new Set([...leaderMap.keys(), ...userMap.keys()]);
  let html = '';

  for (const key of allKeys) {
    const lp = leaderMap.get(key);
    const up = userMap.get(key);

    const symbol = lp ? lp.symbol : up?.symbol || '';
    const side = lp ? lp.positionSide : up?.positionSide || 'LONG';
    const leverage = lp?.leverage || up?.leverage || 10;

    const sideBadge = side === 'LONG' 
      ? '<span class="badge badge-green">LONG</span>' 
      : '<span class="badge badge-red">SHORT</span>';

    const leaderPnlColor = lp && lp.unrealizedProfit >= 0 ? 'text-green' : 'text-red';
    const userPnlColor = up && up.unRealizedProfit >= 0 ? 'text-green' : 'text-red';

    let syncBadge = '';
    if (lp && up) {
      syncBadge = `<span class="badge badge-cyan">${t('badge_connected', 'TERKONEKSI')}</span>`;
    } else if (up && !lp) {
      syncBadge = isPrivate 
        ? `<span class="badge badge-cyan">${t('badge_active_stream', 'AKTIF (STREAM)')}</span>` 
        : `<span class="badge badge-yellow">${t('badge_waiting_close', 'MENUNGGU CLOSE')}</span>`;
    } else {
      syncBadge = `<span class="badge badge-yellow">${t('badge_waiting_sync', 'MENUNGGU SINKRON')}</span>`;
    }

    const ratioDisplay = (up && lp && lp.amount > 0) 
      ? `${((Math.abs(up.positionAmt) / lp.amount) * 100).toFixed(2)}%` 
      : (up && isPrivate ? 'Stream' : '--');

    const leaderVolDisplay = lp 
      ? `${formatQty(lp.amount)} ${symbol.replace('USDT', '')}` 
      : (isPrivate ? `<span class="text-dim">${currentLang === 'en' ? 'Private' : 'Privat'}</span>` : '--');

    const leaderEntryDisplay = lp 
      ? `$${formatPrice(lp.entryPrice)}` 
      : (isPrivate && up ? `$${formatPrice(up.entryPrice)}` : '--');

    // Hitung margin terpakai
    let userMargin = 0;
    let userMarginDisplay = '<span class="text-muted">--</span>';
    if (up && Math.abs(up.positionAmt) > 0) {
      if (typeof up.margin === 'number' && up.margin > 0) {
        userMargin = up.margin;
      } else {
        const pPrice = up.entryPrice > 0 ? up.entryPrice : (up.markPrice || 0);
        userMargin = (Math.abs(up.positionAmt) * pPrice) / Math.max(1, up.leverage || 10);
      }
      userMarginDisplay = `<span class="text-yellow font-bold">$${formatNumber(userMargin)}</span> <span class="text-dim text-xs">USDT</span>`;
    }

    let leaderMarginDisplay = '';
    let leaderMargin = 0;
    if (lp && lp.amount > 0 && lp.entryPrice > 0) {
      leaderMargin = (lp.amount * lp.entryPrice) / Math.max(1, lp.leverage || 10);
      leaderMarginDisplay = `<small class="text-dim">L: $${formatNumber(leaderMargin)}</small><br/>`;
    }

    // Hitung persentase ROI (%)
    let userRoiDisplay = '<span class="text-muted">--</span>';
    let userRoiColor = 'text-muted';
    if (up && userMargin > 0) {
      const userRoi = (up.unRealizedProfit / userMargin) * 100;
      userRoiColor = userRoi >= 0 ? 'text-green' : 'text-red';
      userRoiDisplay = `${userRoi >= 0 ? '+' : ''}${userRoi.toFixed(2)}%`;
    }

    let leaderRoiDisplay = '';
    if (lp && leaderMargin > 0) {
      const leaderRoi = (lp.unrealizedProfit / leaderMargin) * 100;
      const leaderRoiColor = leaderRoi >= 0 ? 'text-green' : 'text-red';
      leaderRoiDisplay = `<small class="${leaderRoiColor}">L: ${leaderRoi >= 0 ? '+' : ''}${leaderRoi.toFixed(2)}%</small><br/>`;
    }

    html += `
      <tr>
        <td><b>${symbol}</b> ${sideBadge} <span class="badge badge-purple">${leverage}x</span></td>
        <td>${leaderVolDisplay}</td>
        <td>${leaderEntryDisplay}</td>
        <td>${up ? `${formatQty(Math.abs(up.positionAmt))} ${symbol.replace('USDT', '')}` : `<span class="text-muted">${currentLang === 'en' ? 'None' : 'Belum ada'}</span>`}</td>
        <td>${up ? `$${formatPrice(up.entryPrice)}` : '--'}</td>
        <td>${leaderMarginDisplay}${userMarginDisplay}</td>
        <td>${ratioDisplay}</td>
        <td>
          ${lp ? `<span class="${leaderPnlColor}">L: $${formatNumber(lp.unrealizedProfit)}</span><br/>` : ''}
          <span class="${userPnlColor}">U: ${up ? `$${formatNumber(up.unRealizedProfit)}` : '--'}</span>
        </td>
        <td>
          ${leaderRoiDisplay}
          <span class="${userRoiColor}">U: ${userRoiDisplay}</span>
        </td>
        <td>${syncBadge}</td>
      </tr>
    `;
  }

  positionsTableBody.innerHTML = html;
  lucide.createIcons({ root: positionsTableBody });
}

function switchTableTab(tab) {
  currentTableTab = tab;
  const tabBtnActive = document.getElementById('tabBtnActive');
  const tabBtnClosed = document.getElementById('tabBtnClosed');
  const viewActive = document.getElementById('viewActivePositions');
  const viewClosed = document.getElementById('viewClosedTrades');
  const btnTableAction = document.getElementById('btnTableAction');
  const iconTableAction = document.getElementById('iconTableAction');

  if (tab === 'active') {
    if (tabBtnActive) tabBtnActive.classList.add('active');
    if (tabBtnClosed) tabBtnClosed.classList.remove('active');
    if (viewActive) viewActive.style.display = 'block';
    if (viewClosed) viewClosed.style.display = 'none';
    if (btnTableAction) btnTableAction.title = t('refresh_tooltip', 'Segarkan Data');
    if (iconTableAction) iconTableAction.setAttribute('data-lucide', 'refresh-cw');
  } else {
    if (tabBtnActive) tabBtnActive.classList.remove('active');
    if (tabBtnClosed) tabBtnClosed.classList.add('active');
    if (viewActive) viewActive.style.display = 'none';
    if (viewClosed) viewClosed.style.display = 'block';
    if (btnTableAction) btnTableAction.title = t('clear_history_tooltip', 'Bersihkan Riwayat Trade Selesai');
    if (iconTableAction) iconTableAction.setAttribute('data-lucide', 'trash-2');
    renderClosedTradesTable();
  }
  lucide.createIcons({ root: document.querySelector('.table-section') });
}

function handleTableAction() {
  if (currentTableTab === 'active') {
    fetchInitialData();
  } else {
    clearClosedTrades();
  }
}

function updateClosedTradesUI(trades) {
  closedTradesList = Array.isArray(trades) ? trades : [];
  const closedBadge = document.getElementById('closedCountBadge');
  if (closedBadge) closedBadge.innerText = closedTradesList.length;

  // Hitung Summary Stats
  const totalTrades = closedTradesList.length;
  let winCount = 0;
  let lossCount = 0;
  let totalRealizedPnl = 0;

  for (const item of closedTradesList) {
    const pnl = Number(item.realizedPnl) || 0;
    totalRealizedPnl += pnl;
    if (pnl > 0) winCount++;
    else if (pnl < 0) lossCount++;
  }

  const winRate = totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(1) : '0.0';

  const histTotalTrades = document.getElementById('histTotalTrades');
  const histWinRate = document.getElementById('histWinRate');
  const histTotalPnl = document.getElementById('histTotalPnl');
  const histWinLoss = document.getElementById('histWinLoss');

  if (histTotalTrades) histTotalTrades.innerText = totalTrades;
  if (histWinRate) histWinRate.innerText = `${winRate}%`;
  if (histTotalPnl) {
    histTotalPnl.innerText = `${totalRealizedPnl >= 0 ? '+' : ''}$${totalRealizedPnl.toFixed(2)} USDT`;
    histTotalPnl.className = `stat-chip-val ${totalRealizedPnl > 0 ? 'text-green' : totalRealizedPnl < 0 ? 'text-red' : ''}`;
  }
  if (histWinLoss) histWinLoss.innerText = `${winCount}W / ${lossCount}L`;

  if (currentTableTab === 'closed') {
    renderClosedTradesTable();
  }
}

function renderClosedTradesTable() {
  const tbody = document.getElementById('closedTradesTableBody');
  if (!tbody) return;

  if (closedTradesList.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row">
        <td colspan="9">
          <div class="empty-state">
            <i data-lucide="history" class="empty-icon"></i>
            <p>${t('empty_closed_title', 'Belum ada riwayat transaksi yang ditutup.')}</p>
            <small>${t('empty_closed_desc', 'Setiap transaksi yang selesai (TP penuh, TP parsial, Cut Loss) akan dicatat rapi di sini.')}</small>
          </div>
        </td>
      </tr>
    `;
    lucide.createIcons({ root: tbody });
    return;
  }

  let html = '';
  for (const item of closedTradesList) {
    const pnl = Number(item.realizedPnl) || 0;
    const isWin = pnl >= 0;
    const pnlClass = isWin ? 'text-green' : 'text-red';
    const sideBadgeClass = item.positionSide === 'LONG' ? 'badge-green' : 'badge-red';

    let actionBadge = '';
    if (item.action === 'FULL_CLOSE') {
      actionBadge = `<span class="badge-action badge-action-full">${t('badge_action_full', 'Tutup Penuh')}</span>`;
    } else if (item.action === 'PARTIAL_CLOSE') {
      actionBadge = `<span class="badge-action badge-action-partial">${t('badge_action_partial', 'Tutup Parsial')}</span>`;
    } else if (item.action === 'EMERGENCY_SL') {
      actionBadge = `<span class="badge-action badge-action-sl">${t('badge_action_sl', 'Emergency SL')}</span>`;
    } else if (item.action === 'PANIC_CLOSE') {
      actionBadge = `<span class="badge-action badge-action-panic">${t('badge_action_panic', 'Panic Close')}</span>`;
    } else {
      actionBadge = `<span class="badge-action">${item.action}</span>`;
    }

    const modeBadge = item.isPaper 
      ? `<span class="badge badge-purple" style="font-size: 0.65rem;">${t('badge_sim', 'Simulasi')}</span>` 
      : `<span class="badge badge-green" style="font-size: 0.65rem;">${t('badge_live', 'Live')}</span>`;

    html += `
      <tr>
        <td style="color: var(--text-dim); font-size: 0.76rem;">${item.closedAt}</td>
        <td>
          <div style="display: flex; align-items: center; gap: 6px;">
            <strong>${item.symbol}</strong>
            <span class="badge ${sideBadgeClass}" style="font-size: 0.68rem; padding: 1px 6px;">${item.positionSide}</span>
          </div>
        </td>
        <td>${actionBadge}</td>
        <td>${formatQty(item.qty)}</td>
        <td>$${formatPrice(item.entryPrice)}</td>
        <td>$${formatPrice(item.closePrice)}</td>
        <td class="${pnlClass}" style="font-weight: 700;">
          ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDT
        </td>
        <td class="${pnlClass}" style="font-weight: 600;">
          ${(item.pnlPct || 0) >= 0 ? '+' : ''}${Number(item.pnlPct || 0).toFixed(2)}%
        </td>
        <td>${modeBadge}</td>
      </tr>
    `;
  }

  tbody.innerHTML = html;
  lucide.createIcons({ root: tbody });
}

async function clearClosedTrades() {
  if (closedTradesList.length === 0) {
    alert(t('alert_hist_empty', 'Riwayat transaksi selesai masih kosong.'));
    return;
  }
  if (!confirm(t('confirm_clear_hist', 'Apakah Anda yakin ingin menghapus seluruh riwayat trade selesai?'))) return;
  try {
    const res = await apiFetch('/api/clear-closed-trades', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      closedTradesList = [];
      updateClosedTradesUI([]);
      appendLog('INFO', '🧹 Riwayat trade selesai telah dibersihkan.');
      alert(t('alert_clear_hist_success', '✅ Riwayat trade selesai berhasil dibersihkan!'));
    } else {
      alert(`Gagal menghapus riwayat: ${data.message}`);
    }
  } catch (e) {
    alert(`Error: ${e.message}`);
  }
}

function appendLog(level, message, timestamp) {
  const time = timestamp || new Date().toLocaleTimeString('id-ID');
  const line = document.createElement('div');
  line.className = `log-line log-${level.toLowerCase()}`;
  line.innerHTML = `
    <span class="log-time">[${time}]</span>
    <span class="log-msg">${escapeHtml(message)}</span>
  `;
  terminalLogBox.appendChild(line);
  // Batasi history maksimal 150 baris agar DOM tetap ringan dan scroll lancar
  while (terminalLogBox.children.length > 150) {
    terminalLogBox.removeChild(terminalLogBox.firstChild);
  }
  terminalLogBox.scrollTop = terminalLogBox.scrollHeight;
}

function clearLogs() {
  terminalLogBox.innerHTML = '';
}

async function toggleEngine() {
  try {
    const endpoint = isEngineActive ? '/api/engine/stop' : '/api/engine/start';
    const res = await apiFetch(endpoint, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      isEngineActive = !isEngineActive;
      updateEngineUI({ isActive: isEngineActive });
    } else {
      alert(`Gagal mengubah status engine: ${data.message}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function confirmPanicClose() {
  const confirmed = confirm(t('confirm_panic_close', 'APAKAH ANDA YAKIN?\n\nSemua posisi copy-trade yang sedang terbuka di akun Binance Anda akan ditutup seketika dengan order Market!'));
  if (!confirmed) return;

  try {
    const res = await apiFetch('/api/panic-close', { method: 'POST' });
    const data = await res.json();
    alert(data.message || 'Panic close selesai diproses');
    refreshData();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function refreshData() {
  try {
    const res = await apiFetch('/api/status');
    const data = await res.json();
    updateEngineUI(data.status);
    if (data.leader) {
      updateLeaderUI(data.leader, data.user?.positions || []);
    }
    if (data.user) {
      updateUserAccountUI(data.user.balance, data.user.positions);
    }
    appendLog('INFO', 'Data berhasil disegarkan manual');
  } catch (err) {
    appendLog('ERROR', `Gagal segarkan data: ${err.message}`);
  }
}

// Modal & Settings Handling
function openSettingsModal() {
  if (!currentConfig) return;
  checkPaperTrading.checked = currentConfig.paperTrading !== false;
  inputVirtualBalance.value = currentConfig.virtualBalanceUsdt ?? 100;
  inputPortfolioId.value = currentConfig.portfolioId || '';
  selectMode.value = currentConfig.mode || 'RATIO_EQUITY';
  if (selectPollingInterval) selectPollingInterval.value = currentConfig.pollingIntervalMs || 1500;
  inputRatioMultiplier.value = currentConfig.ratioMultiplier ?? 1.0;
  inputFixedAmount.value = currentConfig.fixedAmountUsdt ?? 25;
  inputMaxModalPerCoin.value = currentConfig.maxModalPerCoin ?? 50;
  inputMaxSlippage.value = currentConfig.maxSlippagePct ?? 0.5;
  inputEmergencySl.value = currentConfig.emergencySlPct ?? 10;
  checkSyncLeverage.checked = currentConfig.syncLeverage ?? true;

  // Proxy
  checkProxyEnabled.checked = currentConfig.proxy?.enabled ?? false;
  inputProxyHost.value = currentConfig.proxy?.host || '';
  inputProxyPort.value = currentConfig.proxy?.port || '';
  inputProxyUser.value = currentConfig.proxy?.username || '';
  inputProxyPass.value = currentConfig.proxy?.password || '';

  // Binance
  inputApiKey.value = currentConfig.binanceApiKey || '';
  inputSecretKey.value = currentConfig.binanceSecretKey || '';
  checkIsTestnet.checked = currentConfig.isTestnet ?? false;

  // Telegram
  if (checkTelegramEnabled) checkTelegramEnabled.checked = currentConfig.telegram?.enabled ?? false;
  if (inputTelegramToken) inputTelegramToken.value = currentConfig.telegram?.botToken || '';
  if (inputTelegramChatId) inputTelegramChatId.value = currentConfig.telegram?.chatId || '';

  // Adaptive Polling
  const adp = currentConfig.adaptivePolling;
  if (checkAdaptivePolling) checkAdaptivePolling.checked = adp?.enabled ?? true;
  if (selectDawnInterval) selectDawnInterval.value = adp?.dawnIntervalMs || 1000;
  if (selectMorningInterval) selectMorningInterval.value = adp?.morningIntervalMs || 1800;
  if (selectAfternoonInterval) selectAfternoonInterval.value = adp?.afternoonIntervalMs || 3000;
  if (selectNightInterval) selectNightInterval.value = adp?.nightIntervalMs || 1500;

  // Weekend Break (Waktu China CST)
  const wb = currentConfig.weekendBreak;
  if (checkWeekendBreak) checkWeekendBreak.checked = wb?.enabled ?? true;
  if (selectWeekendStandbyInterval) selectWeekendStandbyInterval.value = wb?.standbyIntervalSec || 60;
  if (checkBlockWeekendNewTrades) checkBlockWeekendNewTrades.checked = wb?.blockNewTrades ?? true;
  if (checkSmartReEntry) checkSmartReEntry.checked = wb?.smartReEntryEnabled !== false;
  if (selectReEntryWindow) selectReEntryWindow.value = String(wb?.reEntryWindowMinutes || 30);

  togglePaperTradingInputs();
  toggleProxyInputs();
  toggleTelegramInputs();
  toggleAdaptivePollingInputs();
  toggleWeekendBreakInputs();
  settingsModal.style.display = 'flex';
}

function closeSettingsModal() {
  settingsModal.style.display = 'none';
}

function openTestTradeModal() {
  if (!testTradeModal) return;
  if (testTradeAlertBox) {
    testTradeAlertBox.style.display = 'none';
    testTradeAlertBox.innerText = '';
  }
  if (inputTestAmount && currentConfig) {
    inputTestAmount.value = currentConfig.fixedAmountUsdt || 25;
  }
  testTradeModal.style.display = 'flex';
  lucide.createIcons({ root: testTradeModal });
}

function closeTestTradeModal() {
  if (testTradeModal) {
    testTradeModal.style.display = 'none';
  }
}

async function executeTestTrade() {
  const symbol = selectTestSymbol ? selectTestSymbol.value : 'BTCUSDT';
  const positionSide = selectTestSide ? selectTestSide.value : 'LONG';
  const amountUsdt = inputTestAmount ? parseFloat(inputTestAmount.value) : 25;
  const bypassWeekend = checkBypassWeekend ? checkBypassWeekend.checked : false;

  if (btnExecuteTestTrade) {
    btnExecuteTestTrade.disabled = true;
    btnExecuteTestTrade.innerHTML = `<i data-lucide="loader-2" class="spin"></i> <span>${currentLang === 'en' ? 'Executing...' : 'Mengeksekusi...'}</span>`;
    lucide.createIcons({ root: btnExecuteTestTrade });
  }

  if (testTradeAlertBox) {
    testTradeAlertBox.style.display = 'none';
  }

  try {
    const res = await apiFetch('/api/engine/test-order', {
      method: 'POST',
      body: JSON.stringify({
        symbol,
        positionSide,
        amountUsdt,
        bypassWeekend,
      }),
    });
    const data = await res.json();

    if (testTradeAlertBox) {
      testTradeAlertBox.style.display = 'block';
      if (data.success) {
        testTradeAlertBox.style.background = 'rgba(16, 185, 129, 0.15)';
        testTradeAlertBox.style.border = '1px solid rgba(16, 185, 129, 0.4)';
        testTradeAlertBox.style.color = '#34d399';
        testTradeAlertBox.innerHTML = `<strong>✅ BERHASIL MASUK!</strong><br>${data.message}`;
        try { playSound('open'); } catch (e) {}
        handleTableAction();
      } else if (data.blockedByWeekend) {
        testTradeAlertBox.style.background = 'rgba(234, 179, 8, 0.15)';
        testTradeAlertBox.style.border = '1px solid rgba(234, 179, 8, 0.4)';
        testTradeAlertBox.style.color = '#fde047';
        testTradeAlertBox.innerHTML = `<strong>🌴 DITOLAK OLEH ATURAN LIBUR CST!</strong><br>${data.message}`;
      } else {
        testTradeAlertBox.style.background = 'rgba(239, 68, 68, 0.15)';
        testTradeAlertBox.style.border = '1px solid rgba(239, 68, 68, 0.4)';
        testTradeAlertBox.style.color = '#f87171';
        testTradeAlertBox.innerHTML = `<strong>❌ GAGAL EKSEKUSI:</strong><br>${data.message || 'Terjadi kesalahan sistem'}`;
      }
    }
  } catch (err) {
    if (testTradeAlertBox) {
      testTradeAlertBox.style.display = 'block';
      testTradeAlertBox.style.background = 'rgba(239, 68, 68, 0.15)';
      testTradeAlertBox.style.border = '1px solid rgba(239, 68, 68, 0.4)';
      testTradeAlertBox.style.color = '#f87171';
      testTradeAlertBox.innerHTML = `<strong>❌ ERROR KONEKSI:</strong><br>${err.message}`;
    }
  } finally {
    if (btnExecuteTestTrade) {
      btnExecuteTestTrade.disabled = false;
      btnExecuteTestTrade.innerHTML = `<i data-lucide="play"></i> <span>${t('btn_run_test_trade', 'Eksekusi Order Uji Coba')}</span>`;
      lucide.createIcons({ root: btnExecuteTestTrade });
    }
  }
}

function togglePaperTradingInputs() {
  const row = document.getElementById('paperTradingInputsRow');
  if (row) {
    row.style.opacity = checkPaperTrading.checked ? '1' : '0.5';
    row.style.pointerEvents = checkPaperTrading.checked ? 'auto' : 'none';
  }
}

function toggleProxyInputs() {
  const row = document.getElementById('proxyInputsRow');
  row.style.opacity = checkProxyEnabled.checked ? '1' : '0.5';
  row.style.pointerEvents = checkProxyEnabled.checked ? 'auto' : 'none';
}

function toggleTelegramInputs() {
  const row = document.getElementById('telegramInputsRow');
  if (row && checkTelegramEnabled) {
    row.style.opacity = checkTelegramEnabled.checked ? '1' : '0.5';
    row.style.pointerEvents = checkTelegramEnabled.checked ? 'auto' : 'none';
  }
}

function toggleWeekendBreakInputs() {
  const isEnabled = checkWeekendBreak ? checkWeekendBreak.checked : true;
  if (weekendBreakInputsRow) {
    weekendBreakInputsRow.style.opacity = isEnabled ? '1' : '0.5';
    weekendBreakInputsRow.style.pointerEvents = isEnabled ? 'auto' : 'none';
  }
  const now = new Date();
  const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
  const cstTime = new Date(utcMs + (8 * 3600000));
  const wibTime = new Date(utcMs + (7 * 3600000));
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const cstStr = `${days[cstTime.getDay()]}, ${String(cstTime.getHours()).padStart(2, '0')}:${String(cstTime.getMinutes()).padStart(2, '0')} CST`;
  const wibStr = `${days[wibTime.getDay()]}, ${String(wibTime.getHours()).padStart(2, '0')}:${String(wibTime.getMinutes()).padStart(2, '0')} WIB`;
  if (weekendModalCstClock) weekendModalCstClock.innerText = `China: ${cstStr}`;
  if (weekendModalWibClock) weekendModalWibClock.innerText = `WIB: ${wibStr}`;
  if (weekendModalStatusBadge) {
    const isWeekend = cstTime.getDay() === 0 || cstTime.getDay() === 6;
    if (isWeekend) {
      weekendModalStatusBadge.innerText = 'Akhir Pekan CST';
      weekendModalStatusBadge.className = 'badge badge-emerald';
    } else {
      weekendModalStatusBadge.innerText = 'Hari Kerja CST (Aktif)';
      weekendModalStatusBadge.className = 'badge badge-sky';
    }
  }
}

function highlightActiveSession(sessionKey, wibTimeStr) {
  if (currentWibBadge && wibTimeStr) {
    currentWibBadge.innerText = `${t('badge_current_wib', 'Waktu WIB:')} ${wibTimeStr}`;
  }
  const cards = {
    dawn: cardSessionDawn,
    morning: cardSessionMorning,
    afternoon: cardSessionAfternoon,
    night: cardSessionNight,
  };
  Object.keys(cards).forEach(k => {
    if (cards[k]) {
      if (k === sessionKey) {
        cards[k].classList.add('active-session');
      } else {
        cards[k].classList.remove('active-session');
      }
    }
  });
}

function toggleAdaptivePollingInputs() {
  const isAdaptive = checkAdaptivePolling ? checkAdaptivePolling.checked : false;
  if (staticPollingRow) staticPollingRow.style.display = isAdaptive ? 'none' : 'flex';
  if (adaptiveSchedulePanel) adaptiveSchedulePanel.style.display = isAdaptive ? 'block' : 'none';
  if (isAdaptive) {
    const now = new Date();
    const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
    const wibTime = new Date(utcMs + (7 * 3600000));
    const hour = wibTime.getHours();
    const minute = wibTime.getMinutes();
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');
    let sessionKey = 'dawn';
    if (hour >= 0 && hour < 7) sessionKey = 'dawn';
    else if (hour >= 7 && hour < 12) sessionKey = 'morning';
    else if (hour >= 12 && hour < 19) sessionKey = 'afternoon';
    else sessionKey = 'night';
    highlightActiveSession(sessionKey, `${hh}:${mm} WIB`);
  }
}

async function testTelegram() {
  const botToken = inputTelegramToken ? inputTelegramToken.value.trim() : '';
  const chatId = inputTelegramChatId ? inputTelegramChatId.value.trim() : '';

  if (!botToken || !chatId) {
    alert(t('alert_test_telegram_need_inputs', 'Harap masukkan Bot Token dan Chat ID terlebih dahulu!'));
    return;
  }

  const btn = document.getElementById('btnTestTelegram');
  if (btn) {
    btn.disabled = true;
    btn.innerText = currentLang === 'en' ? 'Sending...' : 'Mengirim...';
  }

  try {
    const res = await apiFetch('/api/test-telegram', {
      method: 'POST',
      body: JSON.stringify({ botToken, chatId }),
    });
    const data = await res.json();
    if (data.success) {
      alert(`✅ TELEGRAM TERKONEKSI!\n\n${data.message}\nLatency: ${data.latencyMs || 0} ms\n\nPeriksa aplikasi Telegram Anda untuk melihat pesan.`);
    } else {
      alert(`❌ GAGAL KIRIM TELEGRAM:\n\n${data.message}`);
    }
  } catch (err) {
    alert(`Error uji telegram: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="send"></i> <span>${t('btn_test_telegram', 'Uji Kirim Pesan Telegram')}</span>`;
      lucide.createIcons({ root: btn });
    }
  }
}

async function saveSettings() {
  const payload = {
    paperTrading: checkPaperTrading.checked,
    virtualBalanceUsdt: parseFloat(inputVirtualBalance.value) || 100,
    portfolioId: inputPortfolioId.value.trim(),
    mode: selectMode.value,
    pollingIntervalMs: parseInt(selectPollingInterval.value) || 1500,
    adaptivePolling: {
      enabled: checkAdaptivePolling ? checkAdaptivePolling.checked : true,
      dawnIntervalMs: selectDawnInterval ? parseInt(selectDawnInterval.value) : 1000,
      morningIntervalMs: selectMorningInterval ? parseInt(selectMorningInterval.value) : 1800,
      afternoonIntervalMs: selectAfternoonInterval ? parseInt(selectAfternoonInterval.value) : 3000,
      nightIntervalMs: selectNightInterval ? parseInt(selectNightInterval.value) : 1500,
    },
    weekendBreak: {
      enabled: checkWeekendBreak ? checkWeekendBreak.checked : true,
      timezone: 'CST',
      standbyIntervalSec: parseInt(selectWeekendStandbyInterval?.value || '60') || 60,
      blockNewTrades: checkBlockWeekendNewTrades ? checkBlockWeekendNewTrades.checked : true,
      smartReEntryEnabled: checkSmartReEntry ? checkSmartReEntry.checked : true,
      reEntryWindowMinutes: parseInt(selectReEntryWindow?.value || '30') || 30,
    },
    ratioMultiplier: parseFloat(inputRatioMultiplier.value) || 1.0,
    fixedAmountUsdt: parseFloat(inputFixedAmount.value) || 25,
    maxModalPerCoin: parseFloat(inputMaxModalPerCoin.value) || 50,
    maxSlippagePct: parseFloat(inputMaxSlippage.value) || 0.5,
    emergencySlPct: parseFloat(inputEmergencySl.value) || 10,
    syncLeverage: checkSyncLeverage.checked,
    proxy: {
      enabled: checkProxyEnabled.checked,
      host: inputProxyHost.value.trim(),
      port: parseInt(inputProxyPort.value) || null,
      username: inputProxyUser.value.trim(),
      password: inputProxyPass.value.trim(),
    },
    telegram: {
      enabled: checkTelegramEnabled ? checkTelegramEnabled.checked : false,
      botToken: inputTelegramToken ? inputTelegramToken.value.trim() : '',
      chatId: inputTelegramChatId ? inputTelegramChatId.value.trim() : '',
    },
    binanceApiKey: inputApiKey.value.trim(),
    binanceSecretKey: inputSecretKey.value.trim(),
    isTestnet: checkIsTestnet.checked,
  };

  try {
    const res = await apiFetch('/api/config', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.success) {
      currentConfig = data.config;
      updateConfigSpecs(currentConfig);
      closeSettingsModal();
      appendLog('SUCCESS', t('alert_settings_saved', 'Pengaturan berhasil disimpan!'));
      refreshData();
    } else {
      alert(`Gagal menyimpan pengaturan: ${data.message}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function previewLeader() {
  const portfolioId = inputPortfolioId.value.trim();
  if (!portfolioId) {
    alert(t('alert_preview_need_id', 'Masukkan Portfolio ID terlebih dahulu'));
    return;
  }

  appendLog('INFO', `Mengambil preview untuk leader ${portfolioId}...`);
  try {
    const res = await apiFetch('/api/fetch-leader', {
      method: 'POST',
      body: JSON.stringify({
        portfolioId,
        proxy: {
          enabled: checkProxyEnabled.checked,
          host: inputProxyHost.value.trim(),
          port: parseInt(inputProxyPort.value) || null,
          username: inputProxyUser.value.trim(),
          password: inputProxyPass.value.trim(),
        },
      }),
    });
    const data = await res.json();
    if (data.isSuccess) {
      const isEn = currentLang === 'en';
      const privacyText = data.positionShow 
        ? (isEn ? 'Public (Active Positions)' : 'Publik (Positions Aktif)') 
        : (isEn ? 'Private (Auto Fallback to Latest Records Stream)' : 'Privat (Auto Fallback ke Latest Records Stream)');
      
      const msg = isEn
        ? `✅ SUCCESSFULLY CONNECTED TO BINANCE!\n\nLeader Name: ${data.nickname}\nLeader Margin/Equity: $${formatNumber(data.totalEquity)}\nROI 7D: ${data.roi7d}%\nFollowers: ${data.followerCount} / ${data.maxFollowerCount}\nPrivacy Status: ${privacyText}\nTrade Records Found: ${data.orders?.length || 0} latest orders`
        : `✅ BERHASIL TERHUBUNG KE BINANCE!\n\nNama Leader: ${data.nickname}\nModal Equity Leader: $${formatNumber(data.totalEquity)}\nROI 7D: ${data.roi7d}%\nFollowers: ${data.followerCount} / ${data.maxFollowerCount}\nStatus Privasi: ${privacyText}\nData Transaksi Ditemukan: ${data.orders?.length || 0} order terbaru`;
      alert(msg);
    } else {
      alert(`❌ Gagal mengambil data leader:\n${data.errorMessage}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function testProxy() {
  const host = inputProxyHost.value.trim();
  const port = parseInt(inputProxyPort.value) || null;
  if (!host || !port) {
    alert(t('alert_test_proxy_need_host', 'Harap masukkan Host dan Port proxy terlebih dahulu sebelum menguji!'));
    return;
  }

  const btn = document.getElementById('btnTestProxy');
  btn.disabled = true;
  btn.innerText = currentLang === 'en' ? 'Testing...' : 'Menguji...';

  try {
    const res = await apiFetch('/api/test-proxy', {
      method: 'POST',
      body: JSON.stringify({
        proxy: {
          enabled: true,
          host,
          port,
          username: inputProxyUser.value.trim(),
          password: inputProxyPass.value.trim(),
        },
      }),
    });
    const data = await res.json();
    if (data.success) {
      const isEn = currentLang === 'en';
      alert(isEn 
        ? `✅ PROXY ACTIVE & VALID!\n\nMessage: ${data.message}\nLatency: ${data.latencyMs} ms`
        : `✅ PROXY AKTIF & VALID!\n\nPesan: ${data.message}\nLatency: ${data.latencyMs} ms`);
    } else {
      const isEn = currentLang === 'en';
      alert(isEn ? `❌ PROXY FAILED:\n\n${data.message}` : `❌ PROXY GAGAL:\n\n${data.message}`);
    }
  } catch (err) {
    alert(`Error uji proxy: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="radio"></i> <span>${t('btn_test_proxy', 'Uji Koneksi Proxy')}</span>`;
    lucide.createIcons({ root: btn });
  }
}

// Helpers
function formatNumber(num) {
  if (num === undefined || num === null || isNaN(num)) return '0.00';
  return Number(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatQty(num) {
  if (num === undefined || num === null || isNaN(num)) return '0';
  const val = Math.abs(Number(num));
  if (val === 0) return '0';
  if (val < 0.01) {
    return val.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 6 });
  }
  if (val < 1) {
    return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  if (val < 1000) {
    return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  return val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatPrice(num) {
  if (num === undefined || num === null || isNaN(num)) return '0.00';
  const val = Number(num);
  if (val >= 100) return val.toFixed(2);
  if (val >= 1) return val.toFixed(4);
  return val.toFixed(6);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.innerText = text;
  return div.innerHTML;
}

async function clearLogs() {
  terminalLogBox.innerHTML = `
    <div class="log-line log-info">
      <span class="log-time">[SYSTEM]</span>
      <span class="log-msg">${currentLang === 'en' ? 'Terminal logs cleared.' : 'Log terminal telah dibersihkan.'}</span>
    </div>
  `;
  try {
    await apiFetch('/api/clear-logs', { method: 'POST' });
  } catch (e) {}
}

async function resetDemoData() {
  if (!confirm(t('confirm_reset_demo', 'Apakah Anda yakin ingin menghapus semua riwayat transaksi & posisi virtual demo?'))) return;
  try {
    const res = await apiFetch('/api/reset-demo', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      terminalLogBox.innerHTML = `
        <div class="log-line log-info">
          <span class="log-time">[SYSTEM]</span>
          <span class="log-msg">${currentLang === 'en' ? 'Demo data and virtual positions have been cleared.' : 'Data demo dan posisi virtual telah dibersihkan bersih.'}</span>
        </div>
      `;
      positionsTableBody.innerHTML = `
        <tr class="empty-state-row">
          <td colspan="9">
            <div class="empty-state">
              <i data-lucide="inbox" class="empty-icon"></i>
              <p>${t('empty_open_title', 'Belum ada posisi yang disalin.')}</p>
              <small>${currentLang === 'en' ? 'Demo data has been cleanly reset.' : 'Data demo telah di-reset bersih.'}</small>
            </div>
          </td>
        </tr>
      `;
      lucide.createIcons({ root: positionsTableBody });
      fetchInitialData();
      alert(t('alert_reset_demo_success', '✅ Data riwayat demo & posisi virtual telah dibersihkan!'));
    }
  } catch (err) {
    alert(`Gagal reset demo: ${err.message}`);
  }
}

// Register PWA Service Worker for mobile installability
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      console.log('PWA Service Worker terdaftar:', reg.scope);
    }).catch((err) => {
      console.log('Service Worker gagal:', err);
    });
  });
}
