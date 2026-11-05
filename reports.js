// Shared engine for the report pages fed by sync/ReportsSync.gs (Subscribers,
// Mobile recharge, SIM activations, VNUMBER enrollments). Each Firestore
// collection holds one doc per month: {month, cols: JSON header, rows: JSON rows}
// with aggregated rows only (no personal data). A page passes a config:
//   coll        'mkt_subs' …
//   dims        [{key, label, filter?}]   breakdowns (tables) and, with filter:true, filter dropdowns
//   measures    [{key, label, fmt:'int'|'usd'}]  the first one leads (charts, shares, sorting)
// Layout: filters → KPI strip → trend chart → one ranked table per breakdown.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const app = initializeApp({
  apiKey: "AIzaSyBVS3csw3_p9T_E_wnEXMhyA6EkPE9VtRY",
  authDomain: "telecom-deals-f155b.firebaseapp.com",
  projectId: "telecom-deals-f155b",
  storageBucket: "telecom-deals-f155b.firebasestorage.app",
  messagingSenderId: "182881118188",
  appId: "1:182881118188:web:9d2f09995f7a1393f942c9"
});
const auth = getAuth(app), db = getFirestore(app);
const ALLOWED = ['@011global.com','@011telecom.com'];
const allowedEmail = e => ALLOWED.some(d => (e || '').toLowerCase().endsWith(d));

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const monthName = k => { const [y, m] = k.split('-'); return MN[+m - 1] + ' ' + y; };
const FMT = {
  int: v => Math.round(v).toLocaleString('en-US'),
  usd: v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }),
};
const pct = v => isFinite(v) ? (v * 100).toFixed(1) + '%' : '—';
function delta(cur, prev){
  if (!prev) return '<span class="delta">—</span>';
  const d = (cur - prev) / prev;
  return `<span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(1)}%</span>`;
}

// ── Loading ──
async function load(coll){
  const snap = await getDocs(collection(db, coll));
  const months = {}; let synced = null;
  snap.forEach(d => {
    const x = d.data(), cols = JSON.parse(x.cols || '[]'), rows = JSON.parse(x.rows || '[]');
    months[x.month || d.id] = rows.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
    if (x.syncedAt && (!synced || x.syncedAt > synced)) synced = x.syncedAt;
  });
  return { months, synced };
}

// Local-only preview (?preview on localhost): no sign-in; reads a gitignored
// preview-data/<coll>.json holding {months: {YYYY-MM: [row objects]}}.
const LOCAL_PREVIEW = ['localhost','127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('preview');

// ── Page ──
export function initReport(cfg){
  const gate = html => { $('app').hidden = true; const g = $('gate'); g.hidden = false; g.innerHTML = html; };
  $('signout').onclick = async () => { await signOut(auth); location.href = 'index.html'; };
  if (LOCAL_PREVIEW) {
    $('user-display').textContent = 'Local preview';
    fetch(`preview-data/${cfg.coll}.json`).then(r => r.json()).then(d => { $('gate').hidden = true; $('app').hidden = false; start(cfg, d); });
    return;
  }
  onAuthStateChanged(auth, async user => {
    if (!user || !allowedEmail(user.email)) {
      gate(`<h1>Sign in to continue</h1><p>${esc(cfg.title)} figures are for 011 Global and 011 Telecom staff. Sign in on the marketing dashboard, then come back here.</p><a class="btn primary" href="index.html">Go to sign in</a>`);
      return;
    }
    $('user-display').textContent = user.displayName || user.email;
    gate('<p>Loading…</p>');
    try {
      const data = await load(cfg.coll);
      if (!Object.keys(data.months).length) { gate(`<h1>${esc(cfg.title)}</h1><p>No data yet. It arrives from the nightly Reports API sync.</p>`); return; }
      $('gate').hidden = true; $('app').hidden = false;
      start(cfg, data);
    } catch (e) {
      console.error(e);
      gate(`<h1>${esc(cfg.title)} could not load</h1><p>${/permission|insufficient/i.test(e.message || '') ? `Firestore refused access. The security rules need to allow signed-in staff to read the ${esc(cfg.coll)} collection.` : 'Something went wrong while loading. Reload the page to try again.'}</p>`);
    }
  });
}

function start(cfg, data){
  const keys = Object.keys(data.months).sort();
  const lead = cfg.measures[0];
  const st = { from: keys[keys.length - 1], to: keys[keys.length - 1], f: {}, open: {} };
  const today = new Date().toISOString().slice(0, 7);
  if (st.to === today && keys.length > 1) st.from = st.to = keys[keys.length - 2];   // default: last full month

  $('srcnote').textContent = data.synced ? 'Synced ' + new Date(data.synced).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' from the Reports API' : '';

  // Filters: period + one dropdown per filter dim (values ranked by the lead measure over all months).
  const opt = (v, l, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(l)}</option>`;
  const all = keys.flatMap(k => data.months[k]);
  const fdims = cfg.dims.filter(d => d.filter);
  $('filters').innerHTML =
    `<div class="f"><label for="from">From</label><select id="from">${keys.map(k => opt(k, monthName(k), k === st.from)).join('')}</select></div>
     <div class="f"><label for="to">To</label><select id="to">${keys.map(k => opt(k, monthName(k) + (k === today ? ' (so far)' : ''), k === st.to)).join('')}</select></div>` +
    fdims.map(d => {
      const tot = {}; all.forEach(r => tot[r[d.key]] = (tot[r[d.key]] || 0) + (+r[lead.key] || 0));
      const vals = Object.keys(tot).filter(v => v !== '').sort((a, b) => tot[b] - tot[a]);
      return `<div class="f"><label for="f-${d.key}">${esc(d.label)}</label><select id="f-${d.key}" data-dim="${esc(d.key)}">${opt('', 'All')}${vals.map(v => opt(v, v)).join('')}</select></div>`;
    }).join('');
  $('from').onchange = e => { st.from = e.target.value; if (st.from > st.to) { st.to = st.from; $('to').value = st.to; } render(); };
  $('to').onchange = e => { st.to = e.target.value; if (st.to < st.from) { st.from = st.to; $('from').value = st.from; } render(); };
  fdims.forEach(d => $('f-' + d.key).onchange = e => { st.f[d.key] = e.target.value; render(); });

  let chart;
  function render(){
    const inRange = keys.filter(k => k >= st.from && k <= st.to);
    const n = inRange.length, i0 = keys.indexOf(st.from);
    const prevKeys = i0 - n >= 0 ? keys.slice(i0 - n, i0) : [];
    const pass = r => fdims.every(d => !st.f[d.key] || String(r[d.key]) === st.f[d.key]);
    const rowsOf = ks => ks.flatMap(k => data.months[k]).filter(pass);
    const cur = rowsOf(inRange), prev = rowsOf(prevKeys);
    const sum = (rows, m) => rows.reduce((s, r) => s + (+r[m] || 0), 0);
    const period = n === 1 ? monthName(st.from) : monthName(st.from) + ' – ' + monthName(st.to);
    const prevLabel = prevKeys.length ? (prevKeys.length === 1 ? monthName(prevKeys[0]) : monthName(prevKeys[0]) + ' – ' + monthName(prevKeys[prevKeys.length - 1])) : '';
    const fl = fdims.filter(d => st.f[d.key]).map(d => d.label + ': ' + st.f[d.key]);
    $('sub').textContent = period + (fl.length ? ' · ' + fl.join(' · ') : '') + (prevLabel ? ' · compared with ' + prevLabel : '');

    // KPIs
    const extra = cfg.kpis ? cfg.kpis(cur, prev, sum) : [];
    $('kpis').innerHTML = cfg.measures.map((m, i) => {
      const c = sum(cur, m.key), p = sum(prev, m.key);
      return `<div class="kpi${i === 0 ? ' lead' : ''}"><span class="lbl">${esc(m.label)}</span><span class="v">${FMT[m.fmt](c)}</span>${prevKeys.length ? delta(c, p) : ''}</div>`;
    }).join('') + extra.map(k => `<div class="kpi"><span class="lbl">${esc(k.label)}</span><span class="v">${esc(k.value)}</span>${k.note ? `<span class="delta">${esc(k.note)}</span>` : ''}</div>`).join('');

    // Trend: daily bars for one month, monthly bars otherwise (all months shown, the selection highlighted).
    let labels, vals, colors;
    if (n === 1) {
      const by = {}; cur.forEach(r => by[r.day] = (by[r.day] || 0) + (+r[lead.key] || 0));
      const [y, m] = st.from.split('-').map(Number), days = new Date(y, m, 0).getDate();
      labels = Array.from({ length: days }, (_, i) => String(i + 1));
      vals = labels.map(d => by[st.from + '-' + d.padStart(2, '0')] || 0);
      colors = labels.map(() => '#EE7805');
      $('trendTitle').textContent = lead.label + ' per day';
    } else {
      labels = keys.map(monthName);
      vals = keys.map(k => sum(data.months[k].filter(pass), lead.key));
      colors = keys.map(k => k >= st.from && k <= st.to ? '#EE7805' : '#D4D4D0');
      $('trendTitle').textContent = lead.label + ' per month';
    }
    if (chart) chart.destroy();
    chart = new Chart($('trend'), {
      type: 'bar',
      data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderRadius: 3 }] },
      options: { maintainAspectRatio: false, animation: false, plugins: { legend: { display: false },
        tooltip: { callbacks: { label: c => FMT[lead.fmt](c.parsed.y) } } },
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: v => FMT[lead.fmt](v) } } } },
    });

    // One ranked table per breakdown.
    const total = sum(cur, lead.key);
    $('tables').innerHTML = cfg.dims.map(d => {
      const g = {}, gp = {};
      cur.forEach(r => { const k = r[d.key] === '' ? '(none)' : r[d.key]; const a = g[k] || (g[k] = {}); cfg.measures.forEach(m => a[m.key] = (a[m.key] || 0) + (+r[m.key] || 0)); });
      prev.forEach(r => { const k = r[d.key] === '' ? '(none)' : r[d.key]; gp[k] = (gp[k] || 0) + (+r[lead.key] || 0); });
      const list = Object.entries(g).sort((a, b) => b[1][lead.key] - a[1][lead.key]);
      const open = st.open[d.key], shown = open ? list : list.slice(0, 12);
      return `<section class="panel"><div class="ph"><h2>By ${esc(d.label.toLowerCase())}</h2><p class="note">${list.length} ${list.length === 1 ? 'value' : 'values'}</p></div>
        <div class="tbl"><table><thead><tr><th>${esc(d.label)}</th>${cfg.measures.map(m => `<th>${esc(m.label)}</th>`).join('')}<th>Share</th>${prevKeys.length ? '<th>vs prior</th>' : ''}</tr></thead>
        <tbody>${shown.map(([k, a]) => `<tr><td class="name" title="${esc(k)}">${esc(k)}</td>${cfg.measures.map(m => `<td>${FMT[m.fmt](a[m.key])}</td>`).join('')}<td>${pct(a[lead.key] / total)}</td>${prevKeys.length ? `<td>${delta(a[lead.key], gp[k] || 0)}</td>` : ''}</tr>`).join('')}</tbody>
        <tfoot><tr><td class="name"><b>Total</b></td>${cfg.measures.map(m => `<td><b>${FMT[m.fmt](sum(cur, m.key))}</b></td>`).join('')}<td>100%</td>${prevKeys.length ? `<td>${delta(total, sum(prev, lead.key))}</td>` : ''}</tr></tfoot></table></div>
        ${list.length > 12 ? `<button class="btn ghost more" type="button" data-dim="${esc(d.key)}">${open ? 'Show top 12' : `Show all ${list.length}`}</button>` : ''}</section>`;
    }).join('');
    $('tables').querySelectorAll('.more').forEach(b => b.onclick = () => { st.open[b.dataset.dim] = !st.open[b.dataset.dim]; render(); });
  }
  render();
}
