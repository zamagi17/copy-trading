// State variables
const TOKEN_KEY = 'copytrader_jwt_token';
let ws = null;
let currentConfig = null;
let currentStatus = null;
let isEngineActive = false;

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
const inputCurrentPass = document.getElementById('inputCurrentPass');
const inputNewPass = document.getElementById('inputNewPass');

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
    alert('Harap isi password saat ini dan password baru!');
    return;
  }
  if (newPassword.length < 6) {
    alert('Password baru minimal 6 karakter!');
    return;
  }

  try {
    const res = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (data.success) {
      alert('✅ Password admin berhasil diperbarui!');
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
        if (payload.logs) {
          payload.logs.reverse().forEach((l) => appendLog(l.level, l.message, l.timestamp));
        }
      } else if (type === 'TICK') {
        updateTickData(payload);
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

    if (statusData.user) {
      updateUserAccountUI(statusData.user.balance, statusData.user.positions);
    }
  } catch (err) {
    console.error('Gagal memuat data awal:', err);
  }
}

function updateEngineUI(status) {
  isEngineActive = status?.isActive || false;

  if (isEngineActive) {
    statusDot.className = 'status-dot dot-active';
    statusText.innerText = 'RUNNING';
    statusText.style.color = 'var(--accent-green)';
    btnToggleEngine.className = 'btn btn-danger';
    toggleBtnText.innerText = 'Hentikan Copy Trade';
    toggleIcon.setAttribute('data-lucide', 'square');
  } else {
    statusDot.className = 'status-dot dot-idle';
    statusText.innerText = 'STANDBY';
    statusText.style.color = 'var(--text-muted)';
    btnToggleEngine.className = 'btn btn-success';
    toggleBtnText.innerText = 'Mulai Copy Trade';
    toggleIcon.setAttribute('data-lucide', 'play');
  }
  lucide.createIcons();
}

function updateConfigSpecs(cfg) {
  if (!cfg) return;
  specMode.innerText = cfg.mode || 'RATIO_EQUITY';
  specSafetyCap.innerText = `$${Number(cfg.maxModalPerCoin || 50).toFixed(2)} USDT`;
  specSlippage.innerText = `${Number(cfg.maxSlippagePct || 0.5).toFixed(2)}% Max`;

  const isSim = cfg.paperTrading !== false;
  if (simBadge && simBadgeText) {
    if (isSim) {
      simBadge.style.background = 'rgba(59, 130, 246, 0.15)';
      simBadge.style.borderColor = 'rgba(59, 130, 246, 0.4)';
      simBadge.style.color = '#60a5fa';
      simBadgeText.innerText = 'SIMULASI (FREE TRIAL)';
    } else {
      simBadge.style.background = 'rgba(34, 197, 94, 0.15)';
      simBadge.style.borderColor = 'rgba(34, 197, 94, 0.4)';
      simBadge.style.color = '#22c55e';
      simBadgeText.innerText = 'LIVE BINANCE FUTURES';
    }
  }

  if (cfg.proxy && cfg.proxy.enabled) {
    proxyStatusBadge.innerText = `Proxy: Aktif (${cfg.proxy.host || 'OK'})`;
    proxyStatusBadge.className = 'badge badge-green';
  } else {
    proxyStatusBadge.innerText = 'Proxy: Nonaktif (Direct DoH)';
    proxyStatusBadge.className = 'badge badge-purple';
  }
}

function updateTickData(payload) {
  if (payload.status) {
    updateEngineUI(payload.status);
  }

  // Update Leader Card
  if (payload.leader) {
    const l = payload.leader;
    if (l.nickname) leaderName.innerText = l.nickname;
    if (l.totalEquity) leaderEquityVal.innerText = `${formatNumber(l.totalEquity)}`;
    if (l.roi7d !== undefined) {
      leaderRoiVal.innerText = `${l.roi7d >= 0 ? '+' : ''}${l.roi7d.toFixed(2)}%`;
      leaderRoiVal.className = `metric-val ${l.roi7d >= 0 ? 'text-green' : 'text-red'}`;
    }
    if (l.mdd7d !== undefined) leaderMddVal.innerText = `${l.mdd7d.toFixed(2)}%`;
    if (l.followerCount !== undefined && leaderFollowersBadge) {
      const isFull = l.maxFollowerCount && l.followerCount >= l.maxFollowerCount;
      leaderFollowersBadge.innerText = `Followers: ${l.followerCount} / ${l.maxFollowerCount || 1000}${isFull ? ' (FULL)' : ''}`;
      leaderFollowersBadge.className = `badge ${isFull ? 'badge-yellow' : 'badge-green'}`;
    }
    if (l.avatarUrl && leaderAvatar) {
      leaderAvatar.innerHTML = `<img src="${l.avatarUrl}" alt="${l.nickname || 'Leader'}" style="width: 100%; height: 100%; border-radius: 12px; object-fit: cover;" />`;
    }

    // Render Table Perbandingan Posisi
    renderPositionsTable(l.positions || [], payload.user?.positions || [], l.orders || [], l.positionShow);
  }

  // Update User Account
  if (payload.user) {
    updateUserAccountUI(payload.user.balance, payload.user.positions);
  }
}

function updateUserAccountUI(balance, positions) {
  if (balance) {
    userWalletBalance.innerHTML = `$${formatNumber(balance.totalWalletBalance || balance.availableBalance)} <span class="currency">USDT</span>`;
    userAvailableBalance.innerText = `$${formatNumber(balance.availableBalance)}`;
    
    const pnl = balance.totalUnrealizedProfit || 0;
    userFloatingPnl.innerText = `$${formatNumber(pnl)}`;
    userFloatingPnl.className = `metric-val ${pnl > 0 ? 'text-green' : pnl < 0 ? 'text-red' : 'text-muted'}`;
  }

  const count = positions ? positions.length : 0;
  userOpenPositionsCount.innerText = `${count} Posisi`;
}

function renderPositionsTable(leaderPositions, userPositions, orders = [], positionShow = true) {
  if (!leaderPositions || leaderPositions.length === 0) {
    const isPrivate = positionShow === false;
    positionsTableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="8">
          <div class="empty-state">
            <i data-lucide="${isPrivate ? 'shield' : 'inbox'}" class="empty-icon ${isPrivate ? 'text-purple' : ''}"></i>
            <p>${isPrivate ? '<b>Mode Privat Aktif pada Leader Ini</b>' : 'Leader saat ini belum memiliki posisi aktif terbuka.'}</p>
            <small>${isPrivate 
              ? 'Leader menyembunyikan tab Positions dari publik. <b>Bot otomatis membaca stream feed Latest Records</b> dan akan mengeksekusi order begitu Leader bertransaksi.' 
              : 'Bot akan otomatis membuka posisi begitu mendeteksi transaksi baru dari Leader.'}</small>
          </div>
        </td>
      </tr>
    `;
    lucide.createIcons();
    return;
  }

  const userMap = new Map();
  if (Array.isArray(userPositions)) {
    for (const up of userPositions) {
      userMap.set(`${up.symbol}_${up.positionSide}`, up);
    }
  }

  let html = '';
  for (const lp of leaderPositions) {
    const key = `${lp.symbol}_${lp.positionSide}`;
    const up = userMap.get(key);
    const sideBadge = lp.positionSide === 'LONG' 
      ? '<span class="badge badge-green">LONG</span>' 
      : '<span class="badge badge-red">SHORT</span>';

    const leaderPnlColor = lp.unrealizedProfit >= 0 ? 'text-green' : 'text-red';
    const userPnlColor = up && up.unRealizedProfit >= 0 ? 'text-green' : 'text-red';

    const syncBadge = up 
      ? '<span class="badge badge-cyan">TERKONEKSI</span>' 
      : '<span class="badge badge-yellow">MENUNGGU SINKRON</span>';

    const ratioDisplay = up && lp.amount > 0 
      ? `${((Math.abs(up.positionAmt) / lp.amount) * 100).toFixed(2)}%` 
      : '--';

    html += `
      <tr>
        <td><b>${lp.symbol}</b> ${sideBadge} <span class="badge badge-purple">${lp.leverage}x</span></td>
        <td>${formatNumber(lp.amount)} ${lp.symbol.replace('USDT', '')}</td>
        <td>$${formatPrice(lp.entryPrice)}</td>
        <td>${up ? `${formatNumber(Math.abs(up.positionAmt))} ${lp.symbol.replace('USDT', '')}` : '<span class="text-muted">Belum ada</span>'}</td>
        <td>${up ? `$${formatPrice(up.entryPrice)}` : '--'}</td>
        <td>${ratioDisplay}</td>
        <td>
          <span class="${leaderPnlColor}">L: $${formatNumber(lp.unrealizedProfit)}</span><br/>
          <span class="${userPnlColor}">U: ${up ? `$${formatNumber(up.unRealizedProfit)}` : '--'}</span>
        </td>
        <td>${syncBadge}</td>
      </tr>
    `;
  }

  positionsTableBody.innerHTML = html;
  lucide.createIcons();
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
  const confirmed = confirm('APAKAH ANDA YAKIN?\n\nSemua posisi copy-trade yang sedang terbuka di akun Binance Anda akan ditutup seketika dengan order Market!');
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

  togglePaperTradingInputs();
  toggleProxyInputs();
  settingsModal.style.display = 'flex';
}

function closeSettingsModal() {
  settingsModal.style.display = 'none';
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

async function saveSettings() {
  const payload = {
    paperTrading: checkPaperTrading.checked,
    virtualBalanceUsdt: parseFloat(inputVirtualBalance.value) || 100,
    portfolioId: inputPortfolioId.value.trim(),
    mode: selectMode.value,
    pollingIntervalMs: parseInt(selectPollingInterval.value) || 1500,
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
      appendLog('SUCCESS', 'Pengaturan berhasil disimpan!');
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
    alert('Masukkan Portfolio ID terlebih dahulu');
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
      const privacyText = data.positionShow ? 'Publik (Positions Aktif)' : 'Privat (Auto Fallback ke Latest Records Stream)';
      alert(`✅ BERHASIL TERHUBUNG KE BINANCE!\n\nNama Leader: ${data.nickname}\nModal Equity Leader: $${formatNumber(data.totalEquity)}\nROI 7D: ${data.roi7d}%\nFollowers: ${data.followerCount} / ${data.maxFollowerCount}\nStatus Privasi: ${privacyText}\nData Transaksi Ditemukan: ${data.orders?.length || 0} order terbaru`);
    } else {
      alert(`❌ Gagal mengambil data leader:\n${data.errorMessage}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function testProxy() {
  const btn = document.getElementById('btnTestProxy');
  btn.disabled = true;
  btn.innerText = 'Menguji...';

  try {
    const res = await apiFetch('/api/test-proxy', {
      method: 'POST',
      body: JSON.stringify({
        proxy: {
          enabled: true,
          host: inputProxyHost.value.trim(),
          port: parseInt(inputProxyPort.value) || null,
          username: inputProxyUser.value.trim(),
          password: inputProxyPass.value.trim(),
        },
      }),
    });
    const data = await res.json();
    if (data.success) {
      alert(`✅ PROXY AKTIF & VALID!\n\nPesan: ${data.message}\nLatency: ${data.latencyMs} ms`);
    } else {
      alert(`❌ PROXY GAGAL:\n\n${data.message}`);
    }
  } catch (err) {
    alert(`Error uji proxy: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="radio"></i> Uji Koneksi Proxy';
    lucide.createIcons();
  }
}

// Helpers
function formatNumber(num) {
  if (num === undefined || num === null || isNaN(num)) return '0.00';
  return Number(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
      <span class="log-msg">Log terminal telah dibersihkan.</span>
    </div>
  `;
  try {
    await apiFetch('/api/clear-logs', { method: 'POST' });
  } catch (e) {}
}

async function resetDemoData() {
  if (!confirm('Apakah Anda yakin ingin menghapus semua riwayat transaksi & posisi virtual demo?')) return;
  try {
    const res = await apiFetch('/api/reset-demo', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      terminalLogBox.innerHTML = `
        <div class="log-line log-info">
          <span class="log-time">[SYSTEM]</span>
          <span class="log-msg">Data demo dan posisi virtual telah dibersihkan bersih.</span>
        </div>
      `;
      positionsTableBody.innerHTML = `
        <tr class="empty-state-row">
          <td colspan="9">
            <div class="empty-state">
              <i data-lucide="inbox" class="empty-icon"></i>
              <p>Belum ada posisi yang disalin.</p>
              <small>Data demo telah di-reset bersih.</small>
            </div>
          </td>
        </tr>
      `;
      lucide.createIcons();
      fetchInitialData();
      alert('✅ Data riwayat demo & posisi virtual telah dibersihkan!');
    }
  } catch (err) {
    alert(`Gagal reset demo: ${err.message}`);
  }
}
