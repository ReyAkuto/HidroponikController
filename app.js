// ============================================================
//  app.js — Hydroponic Monitor Dashboard v2.0
//  Multi-page SPA: Dashboard, Monitoring, Riwayat, Notifikasi, Pengaturan
// ============================================================

import { initializeApp }    from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, onValue, push, query, limitToLast, orderByKey, get, set, update }
                            from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut, updateProfile }
                            from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ── Firebase Config ───────────────────────────────────────
const firebaseConfig = {
  apiKey:      "AIzaSyBykwJKz-HYVoM1NSlYZDdr-2adru26Noo",
  authDomain:  "hidroponikcontroller.firebaseapp.com",
  databaseURL: "https://hidroponikcontroller-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:   "hidroponikcontroller",
};

const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

const MONITOR_EMAIL    = "esp32@hidroponik.com";
const MONITOR_PASSWORD = "esp32123";

// ── App State ─────────────────────────────────────────────
const MAX_POINTS   = 50;
const MAX_TABLE    = 50;
const history      = { ph: [], tds: [], time: [] };
const tableRows    = [];   // for monitoring real-time table
const notifLog     = [];   // full notification log
let   unreadNotif  = 0;

// Settings (persisted to localStorage)
let settings = {
  phMin: 5.5, phMax: 6.5,
  tdsMin: 600, tdsMax: 1200,
  historyInterval: 10,     // minutes
  plantName: 'Selada Keriting',
  plantDate: '',
  plantDays: 45,
};

// Last Firebase data cache (for settings page display)
let lastEsp1 = null, lastEsp2 = null, lastSystem = null;
let lastHistorySaveTime = 0; // 0 = belum pernah simpan, akan simpan setelah interval pertama

// Chart refs
let trendChart = null, sparkPh = null, sparkTds = null;
let monPhChart = null, monTdsChart = null, riwayatChart = null;

// Track previous status for change-notification
let prevPhStatus = null, prevMode = null, prevEsp2Online = null;

// ── Router ────────────────────────────────────────────────
const PAGES = ['dashboard','monitoring','riwayat','notifikasi','pengaturan'];
let currentPage = 'dashboard';

function navigate(page) {
  if (!PAGES.includes(page)) page = 'dashboard';
  currentPage = page;

  // Toggle page visibility
  PAGES.forEach(p => {
    const el = document.getElementById('page-' + p);
    if (el) el.classList.toggle('hidden', p !== page);
  });

  // Active nav item
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });

  // Topbar title & subtitle
  const titles = {
    dashboard:   { h: 'Dashboard', sub: 'Pantau kondisi sistem hidroponikmu secara real-time.' },
    monitoring:  { h: 'Monitoring', sub: 'Grafik detail & tabel data live dari ESP32.' },
    riwayat:     { h: 'Riwayat Data', sub: 'Histori pH & TDS yang tersimpan di Firebase.' },
    notifikasi:  { h: 'Notifikasi', sub: 'Log semua event & perubahan status sistem.' },
    pengaturan:  { h: 'Pengaturan', sub: 'Konfigurasi sistem & preferensi dashboard.' },
  };
  const t = titles[page];
  if (t) {
    const th = document.getElementById('topbar-title');
    const ts = document.getElementById('topbar-subtitle');
    if (th) th.textContent = t.h;
    if (ts) ts.textContent = t.sub;
  }

  // Reset unread notif badge when entering notifikasi page
  if (page === 'notifikasi') {
    unreadNotif = 0;
    updateNotifBadge();
    renderFullNotifList();
  }

  // Load riwayat data when entering
  if (page === 'riwayat') loadRiwayat();

  // Sync settings display
  if (page === 'pengaturan') {
    syncSettingsDisplay();
    renderCalibUI();
    updateCalibFormulaBadge();
  }

  // Init monitoring charts if needed
  if (page === 'monitoring') {
    initMonCharts();
    renderMonTable();
  }
}

// ── Helper ────────────────────────────────────────────────
function setText(id, val)  { const el = document.getElementById(id); if (el) el.textContent = val; }
function setHTML(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
function $(id)             { return document.getElementById(id); }

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = n => String(n).padStart(2,'0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  const p = n => String(n).padStart(2,'0');
  return `${p(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
function fmtAgo(ms) {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}d lalu`;
  if (s < 3600) return `${Math.floor(s/60)}m lalu`;
  return `${Math.floor(s/3600)}j lalu`;
}

// ── Animated Number Counter ───────────────────────────────
// Smooth eased counter: makin jauh dari target = makin cepat
const _counters = {}; // id → { current, target, raf, decimals, suffix }

function animateTo(id, targetVal, decimals = 2, suffix = '') {
  if (!_counters[id]) {
    _counters[id] = { current: null, target: targetVal, raf: null, decimals, suffix };
  }
  const c = _counters[id];

  // First time — langsung set tanpa animasi
  if (c.current === null) {
    c.current = targetVal;
    _renderCounter(id, c);
    return;
  }

  c.target   = targetVal;
  c.decimals = decimals;
  c.suffix   = suffix;

  if (c.raf) cancelAnimationFrame(c.raf);
  _tickCounter(id, c);
}

function _tickCounter(id, c) {
  const diff = c.target - c.current;
  if (Math.abs(diff) < Math.pow(10, -(c.decimals + 1))) {
    c.current = c.target;
    _renderCounter(id, c);
    return;
  }

  // Easing: step = diff * speed, speed scales with |diff|
  // Clamp speed between 0.04 (slow, nearby) and 0.22 (fast, far)
  const absDiff = Math.abs(diff);
  const speed   = Math.min(0.22, Math.max(0.04, absDiff * 0.12));
  c.current    += diff * speed;

  _renderCounter(id, c);
  c.raf = requestAnimationFrame(() => _tickCounter(id, c));
}

function _renderCounter(id, c) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = c.current.toFixed(c.decimals) + '<span>' + c.suffix + '</span>';
}

// ── Status helpers ────────────────────────────────────────
function phStatus(ph) {
  if (ph === null) return { label: 'N/A', cls: 'badge-offline', cssClass: 'muted' };
  if (ph >= settings.phMin && ph <= settings.phMax) return { label: 'Normal', cls: 'badge-ok', cssClass: 'ok' };
  if ((ph >= settings.phMin - 0.5 && ph < settings.phMin) || (ph > settings.phMax && ph <= settings.phMax + 0.5))
    return { label: 'Perhatian', cls: 'badge-warn', cssClass: 'warn' };
  return { label: 'Kritis', cls: 'badge-danger', cssClass: 'danger' };
}
function tdsStatus(tds) {
  if (tds === null) return { label: 'N/A', cls: 'badge-offline', cssClass: 'muted' };
  if (tds >= settings.tdsMin && tds <= settings.tdsMax) return { label: 'Normal', cls: 'badge-ok', cssClass: 'ok' };
  if (tds < settings.tdsMin || (tds > settings.tdsMax && tds <= settings.tdsMax + 200))
    return { label: 'Perhatian', cls: 'badge-warn', cssClass: 'warn' };
  return { label: 'Kritis', cls: 'badge-danger', cssClass: 'danger' };
}

function setBadge(id, label, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = label;
  el.className = 'sensor-badge ' + cls;
}

// ── Clock ─────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const p = n => String(n).padStart(2,'0');
  const days   = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  setText('clock-time', `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())} WITA`);
  setText('clock-date', `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`);
}
setInterval(updateClock, 1000);
updateClock();

// ── Settings persistence (localStorage) ──────────────────
function loadSettings() {
  try {
    const saved = localStorage.getItem('hydroSettings');
    if (saved) Object.assign(settings, JSON.parse(saved));
  } catch(e) {}
}
function saveSettings() {
  try { localStorage.setItem('hydroSettings', JSON.stringify(settings)); } catch(e) {}
}

// ── Plant info sidebar ────────────────────────────────────
function updatePlantInfo() {
  setText('sidebar-plant-name', settings.plantName || 'Tanaman');
  if (settings.plantDate) {
    const planted = new Date(settings.plantDate);
    const today   = new Date();
    const diffDay = Math.floor((today - planted) / 86400000);
    const target  = settings.plantDays || 45;
    setText('sidebar-plant-age', `Hari ke-${diffDay} · ${diffDay >= target ? '🌟 Siap panen!' : 'Tumbuh normal'}`);
  } else {
    setText('sidebar-plant-age', 'Belum ada info tanam');
  }
}

// ── Notification system ───────────────────────────────────
function pushNotif(title, desc, type) {
  const now = Date.now();
  notifLog.unshift({ title, desc, type, time: fmtTime(now), ts: now });
  if (notifLog.length > 100) notifLog.pop();

  // Only increment unread if not on notifikasi page
  if (currentPage !== 'notifikasi') {
    unreadNotif++;
    updateNotifBadge();
  }

  renderDashboardNotifs();
  if (currentPage === 'notifikasi') renderFullNotifList();
}

function updateNotifBadge() {
  const badge = $('notif-badge-sidebar');
  if (!badge) return;
  if (unreadNotif > 0) {
    badge.style.display = 'inline-flex';
    badge.textContent   = unreadNotif > 99 ? '99+' : unreadNotif;
  } else {
    badge.style.display = 'none';
  }
}

function renderDashboardNotifs() {
  const list = $('notif-list-dashboard');
  if (!list) return;
  const recent = notifLog.slice(0, 5);
  if (!recent.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--t3);padding:8px 0">Belum ada notifikasi.</div>';
    return;
  }
  list.innerHTML = recent.map(n => `
    <div class="notif-item">
      <div class="notif-dot-wrap"><div class="ndot ${n.type}"></div></div>
      <div class="notif-body">
        <div class="notif-title">${n.title}</div>
        <div class="notif-desc">${n.desc}</div>
      </div>
      <div class="notif-time">${n.time}</div>
    </div>`).join('');
}

let notifFilter = 'all';
function renderFullNotifList() {
  const list = $('notif-full-list');
  if (!list) return;

  const filtered = notifFilter === 'all'
    ? notifLog
    : notifLog.filter(n => n.type === notifFilter);

  if (!filtered.length) {
    list.innerHTML = `<div style="font-size:13px;color:var(--t3);text-align:center;padding:40px 0">
      ${notifLog.length ? 'Tidak ada notifikasi dengan filter ini.' : 'Belum ada notifikasi.'}
    </div>`;
    return;
  }

  list.innerHTML = filtered.map(n => `
    <div class="notif-full-item">
      <div class="notif-full-icon ${n.type}">
        ${n.type === 'ok'   ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
        ${n.type === 'warn' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' : ''}
        ${n.type === 'info' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' : ''}
      </div>
      <div class="notif-full-body">
        <div class="notif-full-title">${n.title}</div>
        <div class="notif-full-desc">${n.desc}</div>
      </div>
      <div class="notif-full-time">${n.time}</div>
    </div>`).join('');
}

// ── Charts init ───────────────────────────────────────────
function initDashboardCharts() {
  const ctxPh = $('sparkPh');
  if (ctxPh && !sparkPh) {
    sparkPh = new Chart(ctxPh, {
      type: 'line',
      data: { labels: [], datasets: [{ data: [], borderColor: '#3A8F60', borderWidth: 1.5,
        pointRadius: 0, fill: true, backgroundColor: 'rgba(58,143,96,0.08)', tension: 0.4 }] },
      options: { responsive: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } } }
    });
  }
  const ctxTds = $('sparkTds');
  if (ctxTds && !sparkTds) {
    sparkTds = new Chart(ctxTds, {
      type: 'line',
      data: { labels: [], datasets: [{ data: [], borderColor: '#2E5DA8', borderWidth: 1.5,
        pointRadius: 0, fill: true, backgroundColor: 'rgba(46,93,168,0.08)', tension: 0.4 }] },
      options: { responsive: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } } }
    });
  }
  const ctxTrend = $('trendChart');
  if (ctxTrend && !trendChart) {
    trendChart = new Chart(ctxTrend, {
      type: 'line',
      data: { labels: [],
        datasets: [
          { label: 'pH', data: [], borderColor: '#3A8F60', borderWidth: 2,
            pointRadius: 0, pointHoverRadius: 4, tension: 0.4, fill: false, yAxisID: 'yph' },
          { label: 'TDS (ppm)', data: [], borderColor: '#2E5DA8', borderWidth: 2,
            pointRadius: 0, pointHoverRadius: 4, tension: 0.4, fill: false, yAxisID: 'ytds' },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: {
          backgroundColor: '#fff', titleColor: '#181C19', bodyColor: '#4E5C52',
          borderColor: 'rgba(0,0,0,0.09)', borderWidth: 1, padding: 10,
          callbacks: { title: ctx => ctx[0].label, label: ctx => ` ${ctx.dataset.label}: ${ctx.formattedValue}` }
        }},
        scales: {
          x: { grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { color: '#8A9690', font: { size: 11 }, maxTicksLimit: 8 } },
          yph:  { position: 'left',  grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { color: '#3A8F60', font: { size: 11 } }, title: { display: true, text: 'pH', color: '#3A8F60', font: { size: 11 } } },
          ytds: { position: 'right', grid: { display: false }, ticks: { color: '#2E5DA8', font: { size: 11 } }, title: { display: true, text: 'TDS (ppm)', color: '#2E5DA8', font: { size: 11 } } },
        }
      }
    });
  }
}

function initMonCharts() {
  const commonOpts = (label, color, unit) => ({
    responsive: true, maintainAspectRatio: false, animation: { duration: 150 },
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: {
      backgroundColor: '#fff', titleColor: '#181C19', bodyColor: '#4E5C52',
      borderColor: 'rgba(0,0,0,0.09)', borderWidth: 1, padding: 10,
      callbacks: { label: ctx => ` ${label}: ${ctx.formattedValue} ${unit}` }
    }},
    scales: {
      x: { grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { color: '#8A9690', font: { size: 10 }, maxTicksLimit: 10 } },
      y: { grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { color, font: { size: 10 } } }
    }
  });

  if ($('monPhChart') && !monPhChart) {
    monPhChart = new Chart($('monPhChart'), {
      type: 'line',
      data: { labels: [], datasets: [{
        label: 'pH', data: [], borderColor: '#3A8F60', borderWidth: 2,
        pointRadius: 0, pointHoverRadius: 4, tension: 0.4, fill: true,
        backgroundColor: 'rgba(58,143,96,0.08)'
      }] },
      options: commonOpts('pH', '#3A8F60', '')
    });
  }
  if ($('monTdsChart') && !monTdsChart) {
    monTdsChart = new Chart($('monTdsChart'), {
      type: 'line',
      data: { labels: [], datasets: [{
        label: 'TDS', data: [], borderColor: '#2E5DA8', borderWidth: 2,
        pointRadius: 0, pointHoverRadius: 4, tension: 0.4, fill: true,
        backgroundColor: 'rgba(46,93,168,0.08)'
      }] },
      options: commonOpts('TDS', '#2E5DA8', 'ppm')
    });
  }
  // Sync existing data
  if (monPhChart) {
    monPhChart.data.labels = history.time;
    monPhChart.data.datasets[0].data = history.ph;
    monPhChart.update('none');
  }
  if (monTdsChart) {
    monTdsChart.data.labels = history.time;
    monTdsChart.data.datasets[0].data = history.tds;
    monTdsChart.update('none');
  }
}

// ── Push data to all history arrays ──────────────────────
function pushHistory(ph, tds, sensors) {
  const label = fmtTime(Date.now());
  history.ph.push(ph);
  history.tds.push(tds);
  history.time.push(label);

  if (history.ph.length > MAX_POINTS) {
    history.ph.shift(); history.tds.shift(); history.time.shift();
  }

  // Dashboard sparklines
  [sparkPh, sparkTds].forEach((ch, i) => {
    if (!ch) return;
    ch.data.labels = history.time;
    ch.data.datasets[0].data = [history.ph, history.tds][i];
    ch.update('none');
  });
  // Dashboard trend
  if (trendChart) {
    trendChart.data.labels = history.time;
    trendChart.data.datasets[0].data = history.ph;
    trendChart.data.datasets[1].data = history.tds;
    trendChart.update('none');
  }
  // Monitoring charts (only if initialized)
  if (monPhChart) { monPhChart.data.labels = history.time; monPhChart.data.datasets[0].data = history.ph; monPhChart.update('none'); }
  if (monTdsChart) { monTdsChart.data.labels = history.time; monTdsChart.data.datasets[0].data = history.tds; monTdsChart.update('none'); }

  // Add to monitoring table
  const phs  = phStatus(ph);
  const tdss = tdsStatus(tds);
  tableRows.unshift({
    time: label, ph: ph?.toFixed(2), tds: tds?.toFixed(1),
    phAdc: sensors?.ph_adc ?? '—', phVolt: sensors?.ph_voltage?.toFixed(4) ?? '—',
    tdsAdc: sensors?.tds_adc ?? '—', tdsVolt: sensors?.tds_voltage?.toFixed(4) ?? '—',
    phStatus: phs.label, phStatusCls: phs.cssClass,
    tdsStatus: tdss.label, tdsStatusCls: tdss.cssClass,
  });
  if (tableRows.length > MAX_TABLE) tableRows.pop();
  if (currentPage === 'monitoring') renderMonTable();

  // Save to Firebase history at configured interval
  const _now = Date.now();
  const _intervalMs = settings.historyInterval * 60 * 1000;
  if (ph !== null && tds !== null) {
    const _elapsed = _now - lastHistorySaveTime;
    const _sisa = Math.ceil((_intervalMs - _elapsed) / 1000);
    if (_elapsed >= _intervalMs) {
      lastHistorySaveTime = _now;
      console.log('[History] >> Simpan riwayat pH:', ph.toFixed(2), 'TDS:', tds.toFixed(1));
      saveHistoryRecord(ph, tds, sensors);
    } else {
      console.log('[History] Simpan berikutnya dalam', _sisa, 'detik');
    }
  }
}

function renderMonTable() {
  const tbody = $('mon-table-body');
  if (!tbody) return;
  if (!tableRows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-empty">Menunggu data…</td></tr>';
    return;
  }
  tbody.innerHTML = tableRows.map(r => `
    <tr>
      <td>${r.time}</td>
      <td class="${r.phStatus === 'Kritis' ? 'td-danger' : r.phStatus === 'Perhatian' ? 'td-warn' : ''}">${r.ph}</td>
      <td>${r.phAdc}</td>
      <td>${r.phVolt}</td>
      <td class="${r.tdsStatus === 'Kritis' ? 'td-danger' : r.tdsStatus === 'Perhatian' ? 'td-warn' : ''}">${r.tds}</td>
      <td>${r.tdsAdc}</td>
      <td>${r.tdsVolt}</td>
      <td><span class="table-badge ${r.phStatusCls}">${r.phStatus}</span></td>
      <td><span class="table-badge ${r.tdsStatusCls}">${r.tdsStatus}</span></td>
    </tr>`).join('');
}

// ── Firebase: Save history record ─────────────────────────
async function saveHistoryRecord(ph, tds, sensors) {
  try {
    const histRef = ref(db, 'dashboard/history');
    const record = {
      ts:          Date.now(),
      ph:          ph,
      tds:         tds,
      ph_adc:      sensors?.ph_adc      ?? null,
      ph_voltage:  sensors?.ph_voltage  ?? null,
      tds_adc:     sensors?.tds_adc     ?? null,
      tds_voltage: sensors?.tds_voltage ?? null,
      mode:        lastSystem?.connection_mode ?? 'unknown',
    };
    console.log('[History] Pushing ke Firebase:', record);
    await push(histRef, record);
    console.log('[History] Berhasil tersimpan ke dashboard/history');
  } catch(e) {
    console.error('[History] Gagal simpan histori:', e.message, e);
  }
}


// ── Firebase: Delete history by date range ────────────────
async function deleteHistoryRange() {
  const fromVal = $('delete-from')?.value;
  const toVal   = $('delete-to')?.value;

  if (!fromVal || !toVal) {
    showDeleteStatus('Pilih tanggal mulai dan akhir dulu!', true); return;
  }

  const fromMs = new Date(fromVal).setHours(0, 0, 0, 0);
  const toMs   = new Date(toVal).setHours(23, 59, 59, 999);

  if (fromMs > toMs) {
    showDeleteStatus('Tanggal mulai harus sebelum tanggal akhir!', true); return;
  }

  const confirmEl = $('delete-confirm-row');
  if (confirmEl && !confirmEl.classList.contains('show')) {
    // Tampilkan preview dulu berapa data yang akan dihapus
    showDeleteStatus('Menghitung data...', false);
    const snap = await get(ref(db, 'dashboard/history'));
    if (!snap.exists()) { showDeleteStatus('Tidak ada data untuk dihapus.', true); return; }

    let count = 0;
    snap.forEach(child => {
      const ts = child.val()?.ts;
      if (ts >= fromMs && ts <= toMs) count++;
    });

    if (count === 0) {
      showDeleteStatus('Tidak ada data di rentang tanggal tersebut.', true); return;
    }

    setText('delete-count-preview', count);
    confirmEl.classList.add('show');
    showDeleteStatus('', false);
    return;
  }

  // Sudah konfirmasi — eksekusi hapus
  if (confirmEl) confirmEl.classList.remove('show');
  showDeleteStatus('Menghapus data...', false);

  try {
    const snap = await get(ref(db, 'dashboard/history'));
    if (!snap.exists()) { showDeleteStatus('Tidak ada data.', true); return; }

    const toDelete = [];
    snap.forEach(child => {
      const ts = child.val()?.ts;
      if (ts >= fromMs && ts <= toMs) toDelete.push(child.key);
    });

    // Hapus semua key yang masuk range
    const updates = {};
    toDelete.forEach(key => { updates[key] = null; });
    await update(ref(db, 'dashboard/history'), updates);

    showDeleteStatus(`✓ ${toDelete.length} data berhasil dihapus!`, false);
    pushNotif('Riwayat Dihapus', `${toDelete.length} data dihapus (${fromVal} s/d ${toVal})`, 'warn');
    loadRiwayat();
  } catch(e) {
    console.error('deleteHistoryRange error:', e);
    showDeleteStatus('Gagal hapus: ' + e.message, true);
  }
}

function showDeleteStatus(msg, isError) {
  const el = $('delete-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'delete-status ' + (isError ? 'error' : msg ? 'success' : '');
}

// ── Firebase: Load history ────────────────────────────────
async function loadRiwayat() {
  const tbody = $('riwayat-table-body');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="table-empty pulsing">Memuat data dari Firebase…</td></tr>';

  // Ambil limit dari filter dropdown (default 100)
  const limitEl = $('riwayat-filter');
  const limit   = parseInt(limitEl?.value) || 100;

  try {
    // Strategi: fetch tanpa orderByKey agar tidak bergantung index Firebase.
    // Gunakan limitToLast saja — Firebase push-key sudah kronologis secara lexicographic.
    const hRef = query(
      ref(db, 'dashboard/history'),
      limitToLast(limit)
    );

    const snap = await get(hRef);

    if (!snap.exists()) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Belum ada data tersimpan.</td></tr>';
      // Reset summary
      ['rsum-ph-avg','rsum-ph-minmax','rsum-tds-avg','rsum-tds-minmax','rsum-total']
        .forEach(id => setText(id, '—'));
      return;
    }

    // Kumpulkan semua child node ke array
    const rows = [];
    snap.forEach(child => {
      const val = child.val();
      if (val && typeof val === 'object') {
        rows.push({ key: child.key, ...val });
      }
    });

    console.log(`[Riwayat] Berhasil memuat ${rows.length} data dari Firebase`);

    // Urutkan dari terbaru ke terlama berdasarkan timestamp (ts)
    // Fallback ke push-key jika ts tidak ada
    rows.sort((a, b) => {
      const ta = a.ts ?? 0;
      const tb = b.ts ?? 0;
      return tb - ta; // descending (terbaru di atas)
    });

    // ── Summary stats ─────────────────────────────────────
    const phs  = rows.map(r => r.ph).filter(v => v != null && !isNaN(v));
    const tdss = rows.map(r => r.tds).filter(v => v != null && !isNaN(v));

    if (phs.length) {
      const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
      setText('rsum-ph-avg',     avg(phs));
      setText('rsum-ph-minmax',  `${Math.min(...phs).toFixed(2)} / ${Math.max(...phs).toFixed(2)}`);
    }
    if (tdss.length) {
      setText('rsum-tds-avg',    Math.round(tdss.reduce((a, b) => a + b, 0) / tdss.length) + ' ppm');
      setText('rsum-tds-minmax', `${Math.round(Math.min(...tdss))} / ${Math.round(Math.max(...tdss))} ppm`);
    }
    setText('rsum-total', rows.length + ' data');

    // ── Riwayat Chart ─────────────────────────────────────
    // Tampilkan maks 150 titik di grafik (oldest→newest = kiri→kanan)
    const rCtx = $('riwayatChart');
    if (rCtx) {
      const chartRows = rows.slice(0, 150).reverse(); // balik ke ascending untuk grafik
      const labels    = chartRows.map(r => {
        if (!r.ts) return r.key?.slice(-6) ?? '—';
        const d = new Date(r.ts);
        const p = n => String(n).padStart(2, '0');
        return `${p(d.getDate())}/${p(d.getMonth()+1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
      });
      const phData  = chartRows.map(r => r.ph  ?? null);
      const tdsData = chartRows.map(r => r.tds ?? null);

      if (riwayatChart) { riwayatChart.destroy(); riwayatChart = null; }
      riwayatChart = new Chart(rCtx, {
        type: 'line',
        data: { labels, datasets: [
          { label: 'pH', data: phData, borderColor: '#3A8F60', borderWidth: 2,
            pointRadius: chartRows.length > 60 ? 0 : 2, tension: 0.4, fill: false, yAxisID: 'yph',
            spanGaps: true },
          { label: 'TDS', data: tdsData, borderColor: '#2E5DA8', borderWidth: 2,
            pointRadius: chartRows.length > 60 ? 0 : 2, tension: 0.4, fill: false, yAxisID: 'ytds',
            spanGaps: true },
        ]},
        options: {
          responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false }, tooltip: {
            backgroundColor: '#fff', titleColor: '#181C19', bodyColor: '#4E5C52',
            borderColor: 'rgba(0,0,0,0.09)', borderWidth: 1, padding: 10,
            callbacks: {
              label: ctx => {
                const unit = ctx.datasetIndex === 0 ? ' pH' : ' ppm';
                return ` ${ctx.dataset.label}: ${ctx.formattedValue}${unit}`;
              }
            }
          }},
          scales: {
            x:    { grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { color: '#8A9690', font: { size: 10 }, maxTicksLimit: 10 } },
            yph:  { position: 'left',  grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { color: '#3A8F60', font: { size: 10 } }, title: { display: true, text: 'pH', color: '#3A8F60', font: { size: 10 } } },
            ytds: { position: 'right', grid: { display: false }, ticks: { color: '#2E5DA8', font: { size: 10 } }, title: { display: true, text: 'ppm', color: '#2E5DA8', font: { size: 10 } } },
          }
        }
      });
    }

    // ── Table (semua rows, terbaru di atas) ───────────────
    if (tbody) {
      if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Tidak ada data ditemukan.</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(r => {
        const ps = phStatus(r.ph);
        const phVal  = r.ph  != null ? Number(r.ph).toFixed(2)  : '—';
        const tdsVal = r.tds != null ? Number(r.tds).toFixed(1) : '—';
        return `<tr>
          <td>${fmtDate(r.ts)}</td>
          <td>${fmtTime(r.ts)}</td>
          <td class="${ps.cssClass === 'danger' ? 'td-danger' : ps.cssClass === 'warn' ? 'td-warn' : ''}">${phVal}</td>
          <td>${tdsVal}</td>
          <td>${r.ph_adc  ?? '—'}</td>
          <td>${r.tds_adc ?? '—'}</td>
          <td>${r.mode    ?? '—'}</td>
          <td><span class="table-badge ${ps.cssClass}">${ps.label}</span></td>
        </tr>`;
      }).join('');
    }

  } catch(e) {
    console.error('[Riwayat] Error memuat data:', e);
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="table-empty">Gagal memuat: ${e.message}</td></tr>`;
  }
}

// ── Settings display sync ─────────────────────────────────
function syncSettingsDisplay() {
  // Plant info
  if ($('set-plant-name'))  $('set-plant-name').value  = settings.plantName || '';
  if ($('set-plant-date'))  $('set-plant-date').value  = settings.plantDate || '';
  if ($('set-plant-days'))  $('set-plant-days').value  = settings.plantDays || 45;

  // Alert thresholds
  if ($('set-ph-min'))      $('set-ph-min').value      = settings.phMin;
  if ($('set-ph-max'))      $('set-ph-max').value      = settings.phMax;
  if ($('set-tds-min'))     $('set-tds-min').value     = settings.tdsMin;
  if ($('set-tds-max'))     $('set-tds-max').value     = settings.tdsMax;
  if ($('set-history-interval')) $('set-history-interval').value = settings.historyInterval;

  // Firebase read-only values
  const pump = lastEsp1?.pump || {};
  const tdsMinDisp = pump.tds_min != null ? `${Math.round(pump.tds_min)} ppm` : '—';
  const tdsMaxDisp = pump.tds_max != null ? `${Math.round(pump.tds_max)} ppm` : '—';
  const phMinDisp  = pump.ph_min  != null ? `${Number(pump.ph_min).toFixed(1)}` : '—';
  const phMaxDisp  = pump.ph_max  != null ? `${Number(pump.ph_max).toFixed(1)}` : '—';
  setText('set-tds-range-display',  `${tdsMinDisp} – ${tdsMaxDisp}`);
  setText('set-ph-range-display',   `${phMinDisp} – ${phMaxDisp}`);
  setText('set-pump-nutrisi-display', pump.nutrisi_active ? 'Aktif' : 'Nonaktif');
  setText('set-pump-water-display',   pump.water_active   ? 'Aktif' : 'Nonaktif');
  const mode = lastSystem?.connection_mode;
  setText('set-conn-mode-display', mode === 'internet' ? 'Internet Langsung' : mode === 'lora_relay' ? 'LoRa Relay' : '—');
  setText('set-ctrl-mode-display', pumpControlMode === 'manual' ? 'Manual (Website)' : 'Otomatis (ESP32)');

  // User
  const u = auth.currentUser;
  setText('set-user-display', u ? (u.displayName || u.email) : '—');
}

// ── Pump renderer ─────────────────────────────────────────
function renderPump(id, name, active, connMode) {
  const el = $(id);
  if (!el) return;
  const unavailable = connMode === 'lora_relay';
  const dotCls  = unavailable ? 'off' : active ? 'on' : 'off';
  const statCls = unavailable ? 'off' : active ? 'on' : 'off';
  const statTxt = unavailable ? 'N/A' : active ? 'Aktif' : 'Nonaktif';

  // Tentukan pump key dari id ('pump-nutrisi' → 'nutrisi', 'pump-water' → 'water')
  const pumpKey  = id.replace('pump-', '');
  const isManual = pumpControlMode === 'manual';
  const isOn     = pumpKey === 'nutrisi' ? pumpNutrisiState : pumpWaterState;
  const btnId    = `btn-pump-${pumpKey}`;

  el.innerHTML = `
    <div class="pump-dot ${dotCls}"></div>
    <span class="pump-name">${name}</span>
    <span class="pump-status ${statCls}">${statTxt}</span>
    <button class="pump-ctrl-btn ${isOn ? 'on' : 'off'}"
            id="${btnId}"
            onclick="togglePump('${pumpKey}')"
            ${isManual ? '' : 'disabled'}>
      ${isOn ? 'OFF' : 'ON'}
    </button>`;
}

// ── Main dashboard update ─────────────────────────────────
function updateDashboard(esp1, esp2, system) {
  lastEsp1 = esp1; lastEsp2 = esp2; lastSystem = system;

  console.log('[Dashboard] update — esp1:', esp1, 'system:', system);

  const sensors = esp1?.sensors || {};

  // Gunakan formula kalibrasi jika tersedia, fallback ke ph dari Firebase
  let ph;
  if (calibFormula && sensors.ph_adc != null) {
    const calibPh = adcToPh(Number(sensors.ph_adc));
    ph = (calibPh !== null) ? calibPh : ((sensors.ph != null) ? Number(sensors.ph) : null);
  } else {
    ph = (sensors.ph != null) ? Number(sensors.ph) : null;
  }
  const tds = (sensors.tds != null) ? Number(sensors.tds) : null;

  console.log('[Dashboard] ph:', ph, 'tds:', tds);

  // Sensor values — smooth animated counter
  if (ph  !== null) animateTo('ph-value',  ph,  2, 'pH');
  if (tds !== null) animateTo('tds-value', tds, 1, 'ppm');

  const phs  = phStatus(ph);
  const tdss = tdsStatus(tds);
  setBadge('ph-badge',  phs.label,  phs.cls);
  setBadge('tds-badge', tdss.label, tdss.cls);

  // Notifications on status change
  if (prevPhStatus !== null && prevPhStatus !== phs.label && ph !== null) {
    pushNotif(
      `pH ${phs.label === 'Normal' ? 'normal kembali' : 'terdeteksi ' + phs.label.toLowerCase()}`,
      `pH terkini: ${ph.toFixed(2)}`,
      phs.label === 'Normal' ? 'ok' : 'warn'
    );
  }
  prevPhStatus = phs.label;

  // Raw ADC
  setText('raw-ph-adc',      sensors.ph_adc      ?? '—');
  setText('raw-ph-voltage',  sensors.ph_voltage   != null ? sensors.ph_voltage.toFixed(4)  : '—');
  setText('raw-tds-adc',     sensors.tds_adc     ?? '—');
  setText('raw-tds-voltage', sensors.tds_voltage  != null ? sensors.tds_voltage.toFixed(4) : '—');

  // Push chart + history
  if (ph !== null && tds !== null) pushHistory(ph, tds, sensors);

  // Monitoring top badges
  if ($('mon-ph-badge-top'))  $('mon-ph-badge-top').textContent  = `pH: ${ph?.toFixed(2) ?? '—'}`;
  if ($('mon-tds-badge-top')) $('mon-tds-badge-top').textContent = `TDS: ${tds?.toFixed(1) ?? '—'} ppm`;

  // Monitoring stat cards
  if (ph  !== null) animateTo('mon-ph-val',  ph,  2, '');
  if (tds !== null) animateTo('mon-tds-val', tds, 1, '');
  setText('mon-ph-status', phs.label);
  setText('mon-tds-status',tdss.label);
  setText('mon-ph-volt',   sensors.ph_voltage  != null ? sensors.ph_voltage.toFixed(4)  : '—');
  setText('mon-tds-volt',  sensors.tds_voltage != null ? sensors.tds_voltage.toFixed(4) : '—');
  setText('mon-ph-adc',    sensors.ph_adc  ?? '—');
  setText('mon-tds-adc',   sensors.tds_adc ?? '—');

  // ── Connection mode
  const mode = system?.connection_mode || 'offline';
  const modeEl = $('conn-mode-display');
  if (modeEl) {
    if (mode === 'internet') {
      modeEl.className = 'status-mode mode-internet';
      modeEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Online via Internet`;
    } else if (mode === 'lora_relay') {
      modeEl.className = 'status-mode mode-relay';
      modeEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Relay via LoRa`;
    } else {
      modeEl.className = 'status-mode mode-offline';
      modeEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Sistem Offline`;
    }
  }

  if (prevMode !== null && prevMode !== mode) {
    if (mode === 'lora_relay') pushNotif('Beralih ke LoRa Relay', 'ESP1 tidak terjangkau via internet.', 'warn');
    if (mode === 'internet')   pushNotif('Koneksi Internet Pulih', 'ESP1 kembali online langsung.', 'ok');
    if (mode === 'offline')    pushNotif('Sistem Offline', 'Tidak ada data masuk.', 'warn');
  }
  prevMode = mode;

  // Connection banner
  const banner = $('conn-banner');
  if (banner) {
    if (mode === 'lora_relay') {
      banner.className = 'conn-banner show relay';
      banner.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Data dikirim lewat LoRa relay (ESP2) — beberapa info pompa mungkin tidak tersedia.`;
    } else if (mode === 'offline') {
      banner.className = 'conn-banner show offline';
      banner.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Sistem offline — data terakhir ditampilkan.`;
    } else {
      banner.className = 'conn-banner';
      banner.innerHTML = '';
    }
  }

  // Status rows
  const esp1Status = esp1?.status || {};
  const lastSeenMs = esp1Status.last_seen;
  const directMs   = esp1Status.direct_last_seen;

  // esp1Online: cek direct_last_seen (< 60 detik), fallback ke field online + last_seen
  const now = Date.now();
  let esp1Online = false;
  if (directMs && typeof directMs === 'number') {
    esp1Online = (now - directMs) < 60000;
  } else if (lastSeenMs && typeof lastSeenMs === 'number') {
    esp1Online = (now - lastSeenMs) < 60000;
  } else if (esp1Status.online === true) {
    esp1Online = true;
  }

  console.log('[Dashboard] esp1Online:', esp1Online, 'directMs:', directMs, 'lastSeenMs:', lastSeenMs);

  setText('row-esp1-status', esp1Online ? 'Online' : 'Offline');
  const e1el = $('row-esp1-status');
  if (e1el) e1el.className = 'val ' + (esp1Online ? 'ok' : 'danger');

  setText('row-last-seen', fmtAgo(lastSeenMs));

  const esp2Status  = esp2?.status || {};
  const esp2Online  = esp2Status.online && (Date.now() - (esp2Status.last_seen || 0)) < 60000;
  setText('row-esp2-status', esp2Online ? 'Online' : 'Offline');
  const e2el = $('row-esp2-status');
  if (e2el) e2el.className = 'val ' + (esp2Online ? 'ok' : 'muted');

  if (prevEsp2Online !== null && prevEsp2Online !== esp2Online) {
    pushNotif(`ESP2 ${esp2Online ? 'Online' : 'Offline'}`,
      esp2Online ? 'Relay node aktif kembali.' : 'Relay node tidak merespons.',
      esp2Online ? 'ok' : 'warn');
  }
  prevEsp2Online = esp2Online;

  const pumpRow = esp1?.pump || {};
  const tdsRangeStr = (pumpRow.tds_min != null && pumpRow.tds_max != null)
    ? `${Math.round(pumpRow.tds_min)}–${Math.round(pumpRow.tds_max)} ppm`
    : '—';
  setText('row-target-ph', tdsRangeStr);

  const connMode = esp1?.connection?.mode || mode;
  setText('row-conn-mode', connMode === 'internet' ? 'Internet' : connMode === 'lora_relay' ? 'LoRa Relay' : '—');
  const connModeEl = $('row-conn-mode');
  if (connModeEl) connModeEl.className = 'val ' + (connMode === 'internet' ? 'ok' : connMode === 'lora_relay' ? 'relay' : 'muted');

  // Pumps
  const pump = esp1?.pump || {};
  renderPump('pump-nutrisi', 'Pompa Nutrisi (AB Mix)', pump.nutrisi_active || false, mode);
  renderPump('pump-water',   'Pompa Air Murni',        pump.water_active   || false, mode);

  // Re-sync tombol mode & state pompa setelah render ulang
  // (renderPump recreate innerHTML → tombol harus di-update lagi)
  updatePumpControlUI();

  // LoRa
  const relay = esp2?.relay || {};
  const loraSection = $('lora-section');
  if (loraSection) {
    if (relay.active) {
      loraSection.innerHTML = `
        <div class="lora-grid">
          <div class="lora-stat"><div class="lstat-label">RSSI</div><div class="lstat-val">${relay.lora_rssi ?? '—'}<span class="lstat-unit"> dBm</span></div></div>
          <div class="lora-stat"><div class="lstat-label">SNR</div><div class="lstat-val">${relay.lora_snr != null ? Number(relay.lora_snr).toFixed(1) : '—'}<span class="lstat-unit"> dB</span></div></div>
        </div>`;
    } else {
      loraSection.innerHTML = `<div class="lora-inactive">LoRa tidak aktif — mode internet</div>`;
    }
  }

  // Live-sync settings page if open, tapi skip kalau user lagi aktif di form input
  if (currentPage === 'pengaturan' && !document.activeElement?.closest('.settings-grid')) {
    syncSettingsDisplay();
  }
}

// ── Pump Control State ────────────────────────────────────
let pumpControlMode  = 'auto';   // 'auto' | 'manual'
let pumpNutrisiState = false;    // state pompa nutrisi AB Mix
let pumpWaterState   = false;    // state pompa air murni

const CONTROL_PATH = 'hydroponic/esp1/control';

// Inisialisasi node control di Firebase (hanya jika belum ada)
async function initControlNode() {
  const ctrlRef = ref(db, CONTROL_PATH);
  const snap = await get(ctrlRef);
  if (!snap.exists()) {
    await set(ctrlRef, { mode: 'auto', pump_nutrisi: false, pump_water: false });
  }
}

// Ubah mode (auto / manual)
window.setPumpMode = async function(mode) {
  try {
    await update(ref(db, CONTROL_PATH), { mode, pump_nutrisi: false, pump_water: false });
    pumpControlMode = mode;
    updatePumpControlUI();
    pushNotif('Mode Pompa', `Mode diubah ke: ${mode === 'manual' ? 'Manual' : 'Otomatis'}`, 'info');
  } catch (err) {
    console.error('setPumpMode error:', err);
    pushNotif('Error', 'Gagal mengubah mode pompa: ' + err.message, 'danger');
  }
};

// Toggle pompa individual (hanya aktif di mode manual)
// pump: 'nutrisi' | 'water'
window.togglePump = async function(pump) {
  if (pumpControlMode !== 'manual') return;
  const isNutrisi = pump === 'nutrisi';
  const current   = isNutrisi ? pumpNutrisiState : pumpWaterState;
  const newVal    = !current;

  // Air murni prioritas — kalau nyalakan air, matikan nutrisi; keduanya tidak boleh ON bersamaan
  const updates = {
    [`pump_${pump}`]: newVal,
    ...(newVal ? { [`pump_${isNutrisi ? 'water' : 'nutrisi'}`]: false } : {})
  };

  try {
    await update(ref(db, CONTROL_PATH), updates);
    const label = isNutrisi ? 'Nutrisi (AB Mix)' : 'Air Murni';
    pushNotif('Kontrol Manual', `Pompa ${label} → ${newVal ? 'ON' : 'OFF'}`, newVal ? 'warn' : 'info');
  } catch (err) {
    console.error('togglePump error:', err);
    pushNotif('Error', 'Gagal mengontrol pompa: ' + err.message, 'danger');
  }
};

// Update UI tombol & badge berdasarkan state terkini
function updatePumpControlUI() {
  const isManual = pumpControlMode === 'manual';

  // Mode badge
  const badge = $('pump-mode-badge');
  if (badge) {
    badge.textContent = isManual ? 'Manual' : 'Auto';
    badge.classList.toggle('manual', isManual);
  }

  // Toggle buttons
  const btnAuto   = $('btn-mode-auto');
  const btnManual = $('btn-mode-manual');
  if (btnAuto)   btnAuto.classList.toggle('active', !isManual);
  if (btnManual) btnManual.classList.toggle('active',  isManual);

  // Pompa control buttons
  const btnNutrisi = $('btn-pump-nutrisi');
  const btnWater   = $('btn-pump-water');
  const note       = $('pump-ctrl-note');

  if (note) {
    note.style.opacity = isManual ? '0' : '1';
  }

  // Update tombol label & style sesuai state pompa
  if (btnNutrisi) {
    btnNutrisi.textContent = pumpNutrisiState ? 'OFF' : 'ON';
    btnNutrisi.className   = `pump-ctrl-btn ${pumpNutrisiState ? 'on' : 'off'}`;
    btnNutrisi.disabled    = !isManual;
  }
  if (btnWater) {
    btnWater.textContent = pumpWaterState ? 'OFF' : 'ON';
    btnWater.className   = `pump-ctrl-btn ${pumpWaterState ? 'on' : 'off'}`;
    btnWater.disabled    = !isManual;
  }
}

// Listener realtime untuk sinkronkan state kontrol dari Firebase
function startControlListener() {
  onValue(ref(db, CONTROL_PATH), snap => {
    const data = snap.val();
    if (!data) return;
    pumpControlMode  = data.mode          || 'auto';
    pumpNutrisiState = data.pump_nutrisi  || false;
    pumpWaterState   = data.pump_water    || false;
    updatePumpControlUI();
  });
}

// ── Firebase listeners ────────────────────────────────────
function startListeners() {
  let esp1Data = null, esp2Data = null, sysData = null;

  onValue(ref(db, 'hydroponic/esp1'), snap => {
    esp1Data = snap.val();
    console.log('[Firebase] esp1 data diterima:', esp1Data);
    updateDashboard(esp1Data, esp2Data, sysData);
  }, err => console.error('[Firebase] esp1 error:', err));

  onValue(ref(db, 'hydroponic/esp2'), snap => {
    esp2Data = snap.val();
    updateDashboard(esp1Data, esp2Data, sysData);
  }, err => console.error('[Firebase] esp2 error:', err));

  onValue(ref(db, 'system'), snap => {
    sysData = snap.val();
    console.log('[Firebase] system data diterima:', sysData);
    updateDashboard(esp1Data, esp2Data, sysData);
  }, err => console.error('[Firebase] system error:', err));
}

// ── Auth + init ───────────────────────────────────────────
function showDashboard(user) {
  const displayName = user.displayName || user.email.split('@')[0];
  const initials    = displayName.slice(0,1).toUpperCase();

  setText('sidebar-username',      displayName);
  setText('sidebar-avatar',        initials);
  setText('topbar-greeting-name',  displayName.charAt(0).toUpperCase() + displayName.slice(1) + '!');

  const overlay = $('auth-overlay');
  if (overlay) { overlay.classList.add('hidden'); setTimeout(() => overlay.style.display = 'none', 300); }

  loadSettings();
  loadCalibration();
  updatePlantInfo();
  initDashboardCharts();
  startListeners();
  initControlNode();
  startControlListener();
  pushNotif('Sistem dimulai', 'Dashboard berhasil terhubung ke Firebase.', 'info');
  updateClock();
}

// ── Rename Display Name ──────────────────────────────────
window.openRenameModal = function() {
  const modal = $('rename-modal');
  const input = $('rename-input');
  if (!modal || !input) return;
  const current = auth.currentUser?.displayName || '';
  input.value = current;
  modal.classList.remove('hidden');
  setTimeout(() => input.focus(), 100);
};

window.closeRenameModal = function() {
  $('rename-modal')?.classList.add('hidden');
  $('rename-status').textContent = '';
};

window.saveDisplayName = async function() {
  const input   = $('rename-input');
  const status  = $('rename-status');
  const saveBtn = $('rename-save-btn');
  const newName = input?.value.trim();

  if (!newName) { status.textContent = 'Nama tidak boleh kosong!'; status.className = 'rename-status error'; return; }
  if (!auth.currentUser) { status.textContent = 'Tidak ada user aktif.'; status.className = 'rename-status error'; return; }

  saveBtn.disabled = true;
  status.textContent = 'Menyimpan...';
  status.className = 'rename-status';

  try {
    await updateProfile(auth.currentUser, { displayName: newName });

    // Update semua tampilan nama di UI
    const initials = newName.slice(0,1).toUpperCase();
    setText('sidebar-username',     newName);
    setText('sidebar-avatar',       initials);
    setText('topbar-greeting-name', newName.charAt(0).toUpperCase() + newName.slice(1) + '!');
    setText('set-user-display',     auth.currentUser.email);

    status.textContent = '✓ Nama berhasil diubah!';
    status.className = 'rename-status success';
    pushNotif('Profil Diperbarui', `Nama diubah menjadi "${newName}"`, 'ok');
    setTimeout(() => closeRenameModal(), 1200);
  } catch(e) {
    status.textContent = 'Gagal: ' + e.message;
    status.className = 'rename-status error';
  } finally {
    saveBtn.disabled = false;
  }
};

// ── pH Calibration ────────────────────────────────────────
// calibPoints[n] = { ph: float, adc: float } — n = 1,2,3
const calibPoints = { 1: null, 2: null, 3: null };
let   calibFormula = null;   // { type:'linear'|'quadratic', coeffs:[...] }
let   calibSamplingActive = false;

// Load kalibrasi dari localStorage saat startup
function loadCalibration() {
  try {
    const saved = localStorage.getItem('phCalibration');
    if (saved) {
      const data = JSON.parse(saved);
      if (data.points) Object.assign(calibPoints, data.points);
      if (data.formula) calibFormula = data.formula;
      renderCalibUI();
      updateCalibFormulaBadge();
    }
  } catch(e) { console.warn('loadCalibration error:', e); }
}

function persistCalibration() {
  try {
    localStorage.setItem('phCalibration', JSON.stringify({ points: calibPoints, formula: calibFormula }));
  } catch(e) {}
}

// Simpan ke Firebase juga agar bisa di-read ESP32/app lain
async function pushCalibToFirebase() {
  if (!calibFormula) return;
  try {
    await set(ref(db, 'dashboard/ph_calibration'), {
      formula: calibFormula,
      points: calibPoints,
      updated_at: Date.now()
    });
    console.log('[Calib] Disimpan ke Firebase.');
  } catch(e) {
    console.warn('[Calib] Gagal simpan ke Firebase:', e.message);
  }
}

// Konversi ADC → pH menggunakan formula kalibrasi
function adcToPh(adc) {
  if (!calibFormula || adc == null) return null;
  const c = calibFormula.coeffs;
  if (calibFormula.type === 'linear') {
    // ph = c[0]*adc + c[1]
    return c[0] * adc + c[1];
  } else if (calibFormula.type === 'quadratic') {
    // ph = c[0]*adc^2 + c[1]*adc + c[2]
    return c[0] * adc * adc + c[1] * adc + c[2];
  }
  return null;
}

// Mulai sampling ADC untuk titik kalibrasi ke-n
window.startCalibSampling = function(n) {
  if (calibSamplingActive) {
    showCalibStatus('Ada proses sampling berjalan, tunggu selesai dulu.', true);
    return;
  }

  const phInput = $(`calib-ph-${n}`);
  const phVal   = parseFloat(phInput?.value);
  if (isNaN(phVal) || phVal < 0 || phVal > 14) {
    showCalibStatus(`Masukkan nilai pH buffer yang valid untuk Titik ${n}!`, true);
    phInput?.focus();
    return;
  }

  const durSec = parseInt($(`calib-dur-${n}`)?.value || '10');
  calibSamplingActive = true;

  // UI update
  const btn     = $(`calib-btn-${n}`);
  const progWrap = $(`calib-prog-${n}`);
  const progBar  = $(`calib-prog-bar-${n}`);
  const progLbl  = $(`calib-prog-label-${n}`);
  const status   = $(`calib-pt-${n}-status`);

  if (btn)     { btn.disabled = true; btn.classList.add('sampling'); }
  if (progWrap) progWrap.classList.remove('hidden');
  if (progBar)  progBar.style.width = '0%';
  if (status)   { status.textContent = 'Sampling…'; status.className = 'calib-pt-status sampling'; }
  showCalibStatus('');

  const adcSamples = [];
  const intervalMs = 1000; // ambil sample setiap 1 detik
  const totalTicks = durSec;
  let   tick       = 0;
  let   done       = false;

  const sampleInterval = setInterval(() => {
    // Ambil ADC langsung dari cache terakhir Firebase
    const rawAdc = lastEsp1?.sensors?.ph_adc;
    if (rawAdc != null && !isNaN(Number(rawAdc))) {
      adcSamples.push(Number(rawAdc));
    }

    tick++;
    const pct = Math.round((tick / totalTicks) * 100);
    if (progBar)  progBar.style.width = pct + '%';
    const sisaSec = totalTicks - tick;
    const sisaStr = sisaSec >= 60
      ? `${Math.floor(sisaSec/60)}m ${sisaSec%60}d`
      : `${sisaSec}d`;
    if (progLbl)  progLbl.textContent = adcSamples.length > 0
      ? `Sampling… sisa ${sisaStr} — ADC: ${Number(rawAdc ?? 0).toFixed(0)} (${adcSamples.length} sampel)`
      : `Menunggu data ADC… sisa ${sisaStr}`;

    if (tick >= totalTicks && !done) {
      done = true;
      clearInterval(sampleInterval);
      finishSampling(n, phVal, adcSamples, btn, progWrap, status);
    }
  }, intervalMs);
};

function finishSampling(n, phVal, samples, btn, progWrap, status) {
  calibSamplingActive = false;
  if (btn) { btn.disabled = false; btn.classList.remove('sampling'); }

  if (samples.length === 0) {
    if (status) { status.textContent = 'Gagal — tidak ada data ADC'; status.className = 'calib-pt-status'; }
    if (progWrap) progWrap.classList.add('hidden');
    showCalibStatus('Tidak ada data ADC masuk. Pastikan sensor terhubung dan Firebase streaming aktif.', true);
    return;
  }

  // Rata-rata ADC (buang 10% outlier atas-bawah jika sampel cukup)
  samples.sort((a,b) => a - b);
  let trimmed = samples;
  if (samples.length >= 10) {
    const cut = Math.floor(samples.length * 0.1);
    trimmed   = samples.slice(cut, samples.length - cut);
  }
  const avgAdc = trimmed.reduce((a,b) => a+b, 0) / trimmed.length;

  calibPoints[n] = { ph: phVal, adc: avgAdc };

  // Update UI
  const adcDisplay = $(`calib-adc-${n}`);
  if (adcDisplay) adcDisplay.textContent = avgAdc.toFixed(1);
  if (status) { status.textContent = `✓ ADC: ${avgAdc.toFixed(1)}`; status.className = 'calib-pt-status done'; }
  if (progWrap) progWrap.classList.add('hidden');

  const card = $(`calib-pt-${n}`);
  if (card) card.classList.add('done');

  showCalibStatus(`Titik ${n} berhasil: pH ${phVal} → ADC ${avgAdc.toFixed(1)} (${samples.length} sampel)`, false);
  console.log(`[Calib] Titik ${n}: pH=${phVal}, ADC avg=${avgAdc.toFixed(2)}, samples=${samples.length}`);
}

// Hitung & simpan formula kalibrasi dari titik-titik yang ada
window.saveCalibration = function() {
  const pts = [1,2,3].map(n => calibPoints[n]).filter(p => p != null);

  if (pts.length < 2) {
    showCalibStatus('Butuh minimal 2 titik kalibrasi! Lakukan sampling Titik 1 dan 2 dulu.', true);
    return;
  }

  // Sort by ADC
  pts.sort((a,b) => a.adc - b.adc);

  if (pts.length === 2) {
    // Linear regression: ph = m*adc + b
    const [p1, p2] = pts;
    const m = (p2.ph - p1.ph) / (p2.adc - p1.adc);
    const b = p1.ph - m * p1.adc;
    calibFormula = { type: 'linear', coeffs: [m, b], points: pts, createdAt: Date.now() };
    console.log(`[Calib] Linear: ph = ${m.toExponential(4)} * adc + ${b.toFixed(4)}`);
  } else {
    // Quadratic regression (least squares, 3 points)
    // Solve: [adc^2, adc, 1] * [a,b,c]^T = ph
    const [p1, p2, p3] = pts;
    const x1 = p1.adc, x2 = p2.adc, x3 = p3.adc;
    const y1 = p1.ph,  y2 = p2.ph,  y3 = p3.ph;
    // Cramer's rule for 3x3 system
    const det = x1*x1*(x2-x3) - x2*x2*(x1-x3) + x3*x3*(x1-x2);
    if (Math.abs(det) < 1e-10) {
      // Titik kolinear, pakai linear saja
      const m = (p3.ph - p1.ph) / (p3.adc - p1.adc);
      const b = p1.ph - m * p1.adc;
      calibFormula = { type: 'linear', coeffs: [m, b], points: pts, createdAt: Date.now() };
    } else {
      const a = (y1*(x2-x3) - x1*(y2-y3) + (x2*y3-x3*y2)) / det;
      const b = (x1*x1*(y2-y3) - y1*(x1*x1-x3*x3) + x3*x3*(y1-y2)) / det; // simplified
      // Use numpy-style: solve via direct formula
      // Better: standard quadratic through 3 points
      const denom = (x1-x2)*(x1-x3)*(x2-x3);
      const A = (x3*(y2-y1) + x2*(y1-y3) + x1*(y3-y2)) / denom;
      const B = (x3*x3*(y1-y2) + x2*x2*(y3-y1) + x1*x1*(y2-y3)) / denom;
      const C = (x2*x3*(x2-x3)*y1 + x3*x1*(x3-x1)*y2 + x1*x2*(x1-x2)*y3) / denom;
      calibFormula = { type: 'quadratic', coeffs: [A, B, C], points: pts, createdAt: Date.now() };
      console.log(`[Calib] Quadratic: ph = ${A.toExponential(4)}*adc² + ${B.toExponential(4)}*adc + ${C.toFixed(4)}`);
    }
  }

  persistCalibration();
  pushCalibToFirebase();
  renderCalibResultBox();
  updateCalibFormulaBadge();

  const typeTxt = calibFormula.type === 'quadratic' ? 'kuadratik (3 titik)' : 'linear (2 titik)';
  showCalibStatus(`✓ Kalibrasi disimpan! Formula ${typeTxt} aktif.`, false);
  pushNotif('Kalibrasi pH Disimpan', `Formula ${typeTxt} telah diterapkan ke sensor pH.`, 'ok');
};

window.resetToEsp32Default = function() {
  if (!confirm('Nonaktifkan kalibrasi dashboard? pH akan diambil langsung dari nilai yang dikirim ESP32 (tanpa konversi ADC).')) return;
  calibPoints[1] = null; calibPoints[2] = null; calibPoints[3] = null;
  calibFormula = null;
  persistCalibration();
  // Hapus dari Firebase juga
  try { set(ref(db, 'dashboard/ph_calibration'), null); } catch(e) {}
  renderCalibUI();
  updateCalibFormulaBadge();
  showCalibStatus('✓ Kalibrasi dinonaktifkan — pH kini dibaca langsung dari ESP32.', false);
  pushNotif('Kalibrasi pH Dinonaktifkan', 'pH kembali menggunakan nilai langsung dari ESP32.', 'info');
};

window.resetCalibration = function() {
  if (!confirm('Reset semua titik sampling? Formula kalibrasi yang ada akan tetap aktif sampai kamu simpan ulang atau gunakan pH dari ESP32.')) return;
  calibPoints[1] = null; calibPoints[2] = null; calibPoints[3] = null;
  renderCalibUI();
  showCalibStatus('Titik sampling direset. Lakukan sampling ulang lalu simpan.', false);
};

function renderCalibUI() {
  [1,2,3].forEach(n => {
    const pt = calibPoints[n];
    const card   = $(`calib-pt-${n}`);
    const status = $(`calib-pt-${n}-status`);
    const adcEl  = $(`calib-adc-${n}`);
    const phIn   = $(`calib-ph-${n}`);

    if (pt) {
      if (card)   card.classList.add('done');
      if (status) { status.textContent = `✓ ADC: ${pt.adc.toFixed(1)}`; status.className = 'calib-pt-status done'; }
      if (adcEl)  adcEl.textContent = pt.adc.toFixed(1);
      if (phIn)   phIn.value = pt.ph;
    } else {
      if (card)   card.classList.remove('done');
      if (status) { status.textContent = 'Belum diambil'; status.className = 'calib-pt-status'; }
      if (adcEl)  adcEl.textContent = '—';
    }
  });

  if (calibFormula) renderCalibResultBox();
  else {
    const box = $('calib-result-box');
    if (box) box.style.display = 'none';
  }
}

function renderCalibResultBox() {
  const box  = $('calib-result-box');
  const grid = $('calib-result-grid');
  if (!box || !grid || !calibFormula) return;

  const c    = calibFormula.coeffs;
  let   html = '';

  if (calibFormula.type === 'linear') {
    html += `<div class="calib-result-item"><div class="calib-result-label">Tipe Formula</div><div class="calib-result-val">Linear (y = mx + b)</div></div>`;
    html += `<div class="calib-result-item"><div class="calib-result-label">Slope (m)</div><div class="calib-result-val">${c[0].toExponential(4)}</div></div>`;
    html += `<div class="calib-result-item"><div class="calib-result-label">Intercept (b)</div><div class="calib-result-val">${c[1].toFixed(4)}</div></div>`;
  } else {
    html += `<div class="calib-result-item"><div class="calib-result-label">Tipe Formula</div><div class="calib-result-val">Kuadratik (ax²+bx+c)</div></div>`;
    html += `<div class="calib-result-item"><div class="calib-result-label">a</div><div class="calib-result-val">${c[0].toExponential(4)}</div></div>`;
    html += `<div class="calib-result-item"><div class="calib-result-label">b</div><div class="calib-result-val">${c[1].toExponential(4)}</div></div>`;
    html += `<div class="calib-result-item"><div class="calib-result-label">c</div><div class="calib-result-val">${c[2].toFixed(4)}</div></div>`;
  }

  // Tunjukkan prediksi pH saat ini
  const rawAdc = lastEsp1?.sensors?.ph_adc;
  if (rawAdc != null) {
    const predicted = adcToPh(Number(rawAdc));
    if (predicted !== null) {
      html += `<div class="calib-result-item"><div class="calib-result-label">pH saat ini (ADC: ${rawAdc})</div><div class="calib-result-val" style="color:var(--ok)">${predicted.toFixed(2)}</div></div>`;
    }
  }

  const when = calibFormula.createdAt ? new Date(calibFormula.createdAt).toLocaleString('id-ID') : '—';
  html += `<div class="calib-result-item"><div class="calib-result-label">Dikalibrasi</div><div class="calib-result-val" style="font-size:12px">${when}</div></div>`;

  grid.innerHTML = html;
  box.style.display = 'block';
}

function updateCalibFormulaBadge() {
  const badge = $('calib-formula-badge');
  if (!badge) return;
  if (calibFormula) {
    const typeTxt = calibFormula.type === 'quadratic' ? `Kuadratik (3 titik)` : `Linear (2 titik)`;
    badge.textContent = `✓ ${typeTxt}`;
    badge.classList.add('active');
  } else {
    badge.textContent = 'Belum dikalibrasi';
    badge.classList.remove('active');
  }
}

function showCalibStatus(msg, isError = false) {
  const el = $('calib-save-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'calib-save-status ' + (isError ? 'error' : msg ? 'ok' : '');
}

// ── DOM ready event wiring ────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Nav items (sidebar)
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.page));
  });

  // Notif button in topbar
  const notifTopBtn = document.querySelector('.notif-btn[data-page]');
  if (notifTopBtn) notifTopBtn.addEventListener('click', () => navigate('notifikasi'));

  // Logout buttons
  ['logout-btn','settings-logout-btn'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('click', () => signOut(auth).then(() => location.reload()));
  });

  // Riwayat: filter + refresh
  const rfBtn = $('riwayat-refresh-btn');
  if (rfBtn) rfBtn.addEventListener('click', loadRiwayat);
  const rfFilter = $('riwayat-filter');
  if (rfFilter) rfFilter.addEventListener('change', loadRiwayat);

  // Riwayat: delete range
  const delBtn = $('delete-range-btn');
  if (delBtn) delBtn.addEventListener('click', deleteHistoryRange);
  const delConfirmBtn = $('delete-confirm-btn');
  if (delConfirmBtn) delConfirmBtn.addEventListener('click', deleteHistoryRange);
  const delCancelBtn = $('delete-cancel-btn');
  if (delCancelBtn) delCancelBtn.addEventListener('click', () => {
    $('delete-confirm-row')?.classList.remove('show');
    showDeleteStatus('', false);
  });

  // Notifikasi: filter buttons
  document.querySelectorAll('.notif-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.notif-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      notifFilter = btn.dataset.filter;
      renderFullNotifList();
    });
  });

  // Notifikasi: clear all
  const clearBtn = $('notif-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    notifLog.length = 0;
    unreadNotif = 0;
    updateNotifBadge();
    renderFullNotifList();
    renderDashboardNotifs();
  });

  // Pengaturan: save plant info
  const savePlant = $('set-plant-save');
  if (savePlant) savePlant.addEventListener('click', () => {
    settings.plantName = $('set-plant-name')?.value.trim() || 'Tanaman';
    settings.plantDate = $('set-plant-date')?.value || '';
    settings.plantDays = parseInt($('set-plant-days')?.value) || 45;
    saveSettings();
    updatePlantInfo();
    showSaveStatus('set-plant-status', 'Tersimpan!');
  });

  // Pengaturan: save alert thresholds
  const saveAlert = $('set-alert-save');
  if (saveAlert) saveAlert.addEventListener('click', () => {
    const phMin  = parseFloat($('set-ph-min')?.value);
    const phMax  = parseFloat($('set-ph-max')?.value);
    const tdsMin = parseInt($('set-tds-min')?.value);
    const tdsMax = parseInt($('set-tds-max')?.value);
    const intv   = parseInt($('set-history-interval')?.value);

    if (isNaN(phMin) || isNaN(phMax) || phMin >= phMax) {
      showSaveStatus('set-alert-status', 'pH min harus lebih kecil dari max!', true); return;
    }
    if (isNaN(tdsMin) || isNaN(tdsMax) || tdsMin >= tdsMax) {
      showSaveStatus('set-alert-status', 'TDS min harus lebih kecil dari max!', true); return;
    }

    settings.phMin  = phMin;  settings.phMax  = phMax;
    settings.tdsMin = tdsMin; settings.tdsMax = tdsMax;
    settings.historyInterval = intv || 10;
    saveSettings();
    pushNotif('Pengaturan diperbarui', `Alert: pH ${phMin}–${phMax}, TDS ${tdsMin}–${tdsMax} ppm`, 'info');
    showSaveStatus('set-alert-status', 'Pengaturan disimpan!');
  });

  // ── Mobile Sidebar Toggle ─────────────────────────────
  const sidebar      = document.querySelector('.sidebar');
  const backdrop     = $('sidebar-backdrop');
  const hambBtn      = $('hamburger-btn');
  const closeBtn     = $('sidebar-close-btn');

  function openSidebar() {
    sidebar?.classList.add('open');
    backdrop?.classList.add('visible');
    hambBtn?.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden'; // cegah scroll body saat drawer terbuka
  }
  function closeSidebar() {
    sidebar?.classList.remove('open');
    backdrop?.classList.remove('visible');
    hambBtn?.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  hambBtn?.addEventListener('click', openSidebar);
  closeBtn?.addEventListener('click', closeSidebar);
  backdrop?.addEventListener('click', closeSidebar);

  // Auto-close sidebar saat nav item diklik (mobile UX)
  document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (window.innerWidth <= 768) closeSidebar();
    });
  });

  // Tutup sidebar kalau di-resize ke desktop
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeSidebar();
  });

  // DOM siap — trigger auth jika sudah login sebelumnya
  // Enter key di rename modal
  const renameInput = $('rename-input');
  if (renameInput) renameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveDisplayName(); if (e.key === 'Escape') closeRenameModal(); });

  domReady = true;
  if (pendingUser) onDomAndAuth(pendingUser);
});

function showSaveStatus(id, msg, isError = false) {
  const el = $(id);
  if (!el) return;
  el.textContent  = msg;
  el.style.color  = isError ? 'var(--danger)' : 'var(--ok)';
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 3000);
}

// ── Auth flow ─────────────────────────────────────────────
// Gunakan flag untuk pastikan DOM sudah siap sebelum render
let domReady  = false;
let pendingUser = null;

function onDomAndAuth(user) {
  if (!domReady || !user) return;
  showDashboard(user);
}

onAuthStateChanged(auth, user => {
  if (user) {
    pendingUser = user;
    onDomAndAuth(user);
  } else {
    setText('auth-status', 'Menghubungkan ke Firebase…');
    signInWithEmailAndPassword(auth, MONITOR_EMAIL, MONITOR_PASSWORD)
      .then(cred => { pendingUser = cred.user; onDomAndAuth(cred.user); })
      .catch(err => {
        setText('auth-status', 'Gagal login: ' + err.message);
        console.error(err);
      });
  }
});
