// SEO tab (seo.html), fed by sync/SeoSync.gs, which pulls Google Search Console and
// GA4 nightly for vnumber.com, 011global.com and globusim.com. One Firestore doc
// per month per collection: {month, cols: JSON header, rows: JSON rows} — the same
// shape as the Reports API pages (reports.js). Collections:
//   mkt_seoDaily    [day, site, clicks, impressions, posw]           Search Console per day
//   mkt_seoPages    [site, page, clicks, impressions, posw]          top pages of the month
//   mkt_seoQueries  [site, query, clicks, impressions, posw]         top queries of the month
//   mkt_seoMarkets  [site, country, device, clicks, impressions, posw]
//   mkt_seoGa4      [day, site, channel, sessions, engaged, keyEvents]  GA4 sessions by channel group
//   mkt_seoAi       [site, source, host, page, sessions, engaged, keyEvents]  visits from AI assistants
//   mkt_seoLanding  [site, host, page, channel, sessions, engaged, keyEvents]  GA4 landing pages, all channels
// posw = average position × impressions, so positions can be summed and re-averaged.
// Weekly snapshots (one doc 'latest' each, {cols, rows, syncedAt}):
//   mkt_seoAudit/latest  on-page checks + URL Inspection for top and new pages
//   mkt_seoSpeed/latest  PageSpeed Insights (Lighthouse + field data), mobile and desktop
// Paid vs organic also reads mkt_markets + mkt_dailyStats (the Ads/Meta syncs), on first open.
// Views (hash): overview · pages · blog · landing · queries · markets · new · technical · speed · ai · paid · alerts
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, getDocs, doc, getDoc, query, where } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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

const COLLS = { daily: 'mkt_seoDaily', pages: 'mkt_seoPages', queries: 'mkt_seoQueries', markets: 'mkt_seoMarkets', ga4: 'mkt_seoGa4', ai: 'mkt_seoAi', landing: 'mkt_seoLanding' };
const LATEST = { audit: 'mkt_seoAudit', speed: 'mkt_seoSpeed' };
const SITES = [{ k: 'VNumber', c: '#EE7805' }, { k: '011 Global', c: '#3A6EA5' }, { k: 'GlobuSIM', c: '#6B8E23' }];
const SCOLOR = Object.fromEntries(SITES.map(s => [s.k, s.c]));
const VIEWS = [['overview', 'Overview'], ['pages', 'All pages'], ['blog', 'Blog'], ['landing', 'Landing pages'], ['queries', 'Queries'], ['markets', 'Markets'],
  ['new', 'New pages'], ['technical', 'Technical'], ['speed', 'Speed'], ['ai', 'AI search'], ['paid', 'Paid vs organic'], ['alerts', 'Alerts']];
const FOCUS = new Set(['usa', 'can', 'bra', 'isr', 'gbr', 'nld', 'mex', 'arg', 'ury', 'col']);   // diaspora focus markets
const BRAND_RE = /v\s?numbers?|\b011\b|zero eleven|globu\s?sim/i;
const QUESTION_RE = /^(how|what|which|where|why|when|who|can|could|does|do|is|are|should|will|best|cheapest)\b|\?|\bvs\.?\b/i;
const STAGING_RE = /(^|[.-])(sta|stg|staging|dev|test|qa)([.-]|$)/i;
const COUNTRY = { usa: 'United States', can: 'Canada', bra: 'Brazil', isr: 'Israel', gbr: 'United Kingdom', nld: 'Netherlands', mex: 'Mexico', arg: 'Argentina', ury: 'Uruguay', col: 'Colombia', esp: 'Spain', prt: 'Portugal', fra: 'France', deu: 'Germany', ita: 'Italy', ind: 'India', aus: 'Australia', chl: 'Chile', per: 'Peru', ven: 'Venezuela', zaf: 'South Africa', phl: 'Philippines', che: 'Switzerland', bel: 'Belgium', irl: 'Ireland', ecu: 'Ecuador', pry: 'Paraguay', bol: 'Bolivia', dom: 'Dominican Republic', pan: 'Panama', cri: 'Costa Rica', gtm: 'Guatemala', zzz: 'Unknown' };

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const monthName = k => { const [y, m] = k.split('-'); return MN[+m - 1] + ' ' + y; };
const N = v => Math.round(v || 0).toLocaleString('en-US');
const P = v => isFinite(v) ? (v * 100).toFixed(1) + '%' : '—';
const POS = v => isFinite(v) && v > 0 ? v.toFixed(1) : '—';
function delta(cur, prev){
  if (!prev) return '<span class="delta">—</span>';
  const d = (cur - prev) / prev;
  return `<span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(1)}%</span>`;
}
// Position: lower is better, so a drop in the number is an improvement (shown as ▲).
function deltaPos(cur, prev){
  if (!(cur > 0) || !(prev > 0)) return '<span class="delta">—</span>';
  const d = prev - cur;
  return `<span class="delta ${d >= 0 ? 'up' : 'down'}" title="Positions ${d >= 0 ? 'gained' : 'lost'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}</span>`;
}
const siteDot = s => `<span class="mk" style="background:${SCOLOR[s] || '#888'}"></span>`;

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
async function loadLatest(coll){
  const d = await getDoc(doc(db, coll, 'latest'));
  if (!d.exists()) return { rows: [], synced: null };
  const x = d.data(), cols = JSON.parse(x.cols || '[]');
  return { rows: JSON.parse(x.rows || '[]').map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]]))), synced: x.syncedAt || null };
}
async function loadAll(get, getLatest){
  const names = Object.keys(COLLS), lnames = Object.keys(LATEST);
  const [got, lat] = await Promise.all([Promise.all(names.map(n => get(COLLS[n]))), Promise.all(lnames.map(n => getLatest(LATEST[n]).catch(e => { console.warn(n, e); return { rows: [], synced: null }; })))]);
  const out = Object.fromEntries(names.map((n, i) => [n, got[i]]));
  lnames.forEach((n, i) => out[n] = lat[i]);
  return out;
}
// Paid media from the Ads / Meta syncs: daily cost per market, converted to USD; brand 'vnumber' → VNumber, else 011 Global.
async function loadPaid(since){
  const [ms, ds] = await Promise.all([getDocs(collection(db, 'mkt_markets')), getDocs(query(collection(db, 'mkt_dailyStats'), where('date', '>=', since)))]);
  const markets = []; ms.forEach(d => markets.push({ id: d.id, ...d.data() }));
  const stats = []; ds.forEach(d => { const x = d.data(); stats.push({ marketId: x.marketId, platform: x.platform, date: x.date, cost: x.cost, clicks: x.clicks, conversions: x.conversions }); });
  return { markets, stats };
}
function paidRows(p){
  const m = Object.fromEntries((p.markets || []).map(x => [x.id, x]));
  return (p.stats || []).map(r => { const mk = m[r.marketId] || {}; return { day: r.date, site: mk.brand === 'vnumber' ? 'VNumber' : '011 Global', platform: r.platform === 'meta' ? 'Meta' : 'Google Ads', usd: (+r.cost || 0) * (mk.usdRate || 1), clicks: +r.clicks || 0, conversions: +r.conversions || 0 }; });
}

// Local-only preview (?preview on localhost): no sign-in; reads gitignored preview-data/<coll>.json.
const LOCAL_PREVIEW = ['localhost','127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('preview');

export function initSeo(){
  const gate = html => { $('app').hidden = true; const g = $('gate'); g.hidden = false; g.innerHTML = html; };
  $('signout').onclick = async () => { await signOut(auth); location.href = 'index.html'; };
  if (LOCAL_PREVIEW) {
    $('user-display').textContent = 'Local preview';
    const pf = (c, empty) => fetch(`preview-data/${c}.json`).then(r => r.json()).catch(() => empty);
    loadAll(c => pf(c, { months: {} }), c => pf(c, { rows: [] }))
      .then(d => { $('gate').hidden = true; $('app').hidden = false; start(d, () => pf('seo_paid', { markets: [], stats: [] })); });
    return;
  }
  onAuthStateChanged(auth, async user => {
    if (!user || !allowedEmail(user.email)) {
      gate(`<h1>Sign in to continue</h1><p>SEO figures are for 011 Global and 011 Telecom staff. Sign in on the marketing dashboard, then come back here.</p><a class="btn primary" href="index.html">Go to sign in</a>`);
      return;
    }
    $('user-display').textContent = user.displayName || user.email;
    gate('<p>Loading…</p>');
    try {
      const data = await loadAll(load, loadLatest);
      if (!Object.keys(data.daily.months).length) { gate('<h1>SEO</h1><p>No data yet. It arrives from the nightly Search Console and GA4 sync (sync/SeoSync.gs).</p>'); return; }
      $('gate').hidden = true; $('app').hidden = false;
      start(data, loadPaid);
    } catch (e) {
      console.error(e);
      gate(`<h1>SEO could not load</h1><p>${/permission|insufficient/i.test(e.message || '') ? 'Firestore refused access. The security rules need to allow signed-in staff to read the mkt_seo* collections.' : 'Something went wrong while loading. Reload the page to try again.'}</p>`);
    }
  });
}

// ── Helpers on rows ──
function gscAgg(rows, keyf){
  const m = new Map();
  rows.forEach(r => {
    const k = keyf(r); let a = m.get(k);
    if (!a) { a = { k, r, clicks: 0, impressions: 0, posw: 0 }; m.set(k, a); }
    a.clicks += +r.clicks || 0; a.impressions += +r.impressions || 0; a.posw += +r.posw || 0;
  });
  return m;
}
const tot = rows => { const a = { clicks: 0, impressions: 0, posw: 0 }; rows.forEach(r => { a.clicks += +r.clicks || 0; a.impressions += +r.impressions || 0; a.posw += +r.posw || 0; }); return a; };
const ctr = a => a && a.impressions ? a.clicks / a.impressions : NaN;
const pos = a => a && a.impressions ? a.posw / a.impressions : NaN;
const sum = (rows, f) => rows.reduce((s, r) => s + (+r[f] || 0), 0);

const isLpHost = u => { try { return /^lp[.-]/i.test(new URL(u).host); } catch { return false; } };
function pageType(url){
  let p; try { p = new URL(url).pathname.toLowerCase(); } catch { p = String(url).toLowerCase(); }
  if (/^\/([a-z]{2}(-[a-z]{2})?\/?)?$/.test(p)) return 'Home';
  if (/\/(blogs?|news|articles?|posts?|guides?)(\/|$)/.test(p)) return 'Blog';   // VNumber uses /blogs/
  if (/\/(lp|landing|go|promo|offers?)(\/|$)/.test(p) || isLpHost(url)) return 'Landing';
  return 'Site page';
}

function start(data, getPaid){
  const keys = [...new Set(Object.values(data).flatMap(d => Object.keys(d.months || {})))].sort();
  if (!keys.length) { $('app').innerHTML = '<p class="empty">No data yet.</p>'; return; }
  const today = new Date().toISOString().slice(0, 7);
  const st = { from: keys[keys.length - 1], to: keys[keys.length - 1], site: '', ptype: '', brand: 'nonbrand', q: { pages: '', queries: '' }, open: {}, metric: 'clicks', strategy: 'mobile', lpOnly: 'yes', paid: null, paidErr: '' };
  if (st.to === today && keys.length > 1) st.from = st.to = keys[keys.length - 2];   // default: last full month
  const synced = Object.values(data).map(d => d.synced).filter(Boolean).sort().pop();
  $('srcnote').textContent = synced ? 'Synced ' + new Date(synced).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' from Search Console and GA4' : '';

  const view = () => { const v = (location.hash.match(/^#\/(\w+)/) || [])[1]; return VIEWS.some(x => x[0] === v) ? v : 'overview'; };
  $('views').innerHTML = VIEWS.map(([v, l]) => `<a href="#/${v}" data-v="${v}">${l}</a>`).join('');

  const opt = (v, l, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(l)}</option>`;
  $('filters').innerHTML =
    `<div class="f"><label for="from">From</label><select id="from">${keys.map(k => opt(k, monthName(k), k === st.from)).join('')}</select></div>
     <div class="f"><label for="to">To</label><select id="to">${keys.map(k => opt(k, monthName(k) + (k === today ? ' (so far)' : ''), k === st.to)).join('')}</select></div>
     <div class="f"><span class="lbl">Site</span><div class="seg" role="group" id="site">${[['', 'All sites'], ...SITES.map(s => [s.k, s.k])].map(([v, l]) => `<button type="button" data-site="${esc(v)}" aria-pressed="${st.site === v}">${esc(l)}</button>`).join('')}</div></div>`;
  $('from').onchange = e => { st.from = e.target.value; if (st.from > st.to) { st.to = st.from; $('to').value = st.to; } render(); };
  $('to').onchange = e => { st.to = e.target.value; if (st.to < st.from) { st.from = st.to; $('from').value = st.from; } render(); };
  $('site').querySelectorAll('button').forEach(b => b.onclick = () => {
    st.site = b.dataset.site; $('site').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); render();
  });
  window.addEventListener('hashchange', () => render());

  const charts = [];
  function render(focusId){
    charts.splice(0).forEach(c => c.destroy());
    const v = view();
    $('views').querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.v === v));
    const inRange = keys.filter(k => k >= st.from && k <= st.to), n = inRange.length, i0 = keys.indexOf(st.from);
    const prevKeys = i0 - n >= 0 ? keys.slice(i0 - n, i0) : [];
    const passSite = r => !st.site || r.site === st.site;
    const rowsOf = (name, ks) => ks.flatMap(k => (data[name].months[k] || [])).filter(passSite);
    const C = {}, Pv = {};
    Object.keys(COLLS).forEach(name => { C[name] = rowsOf(name, inRange); Pv[name] = rowsOf(name, prevKeys); });
    const hasPrev = prevKeys.length > 0;
    const period = n === 1 ? monthName(st.from) : monthName(st.from) + ' – ' + monthName(st.to);
    const prevLabel = hasPrev ? (prevKeys.length === 1 ? monthName(prevKeys[0]) : monthName(prevKeys[0]) + ' – ' + monthName(prevKeys[prevKeys.length - 1])) : '';
    $('sub').textContent = (st.site || 'All sites') + ' · ' + period + (inRange.includes(today) ? ' (so far)' : '') + (prevLabel ? ' · compared with ' + prevLabel : '');

    // KPI strip (every view)
    const tc = tot(C.daily), tp = tot(Pv.daily);
    const org = rows => sum(rows.filter(r => r.channel === 'Organic Search'), 'sessions');
    const orgK = rows => sum(rows.filter(r => r.channel === 'Organic Search'), 'keyEvents');
    const kpis = [
      { l: 'Clicks', v: N(tc.clicks), d: delta(tc.clicks, tp.clicks), lead: true },
      { l: 'Impressions', v: N(tc.impressions), d: delta(tc.impressions, tp.impressions) },
      { l: 'CTR', v: P(ctr(tc)), d: delta(ctr(tc), ctr(tp)) },
      { l: 'Avg position', v: POS(pos(tc)), d: deltaPos(pos(tc), pos(tp)) },
      { l: 'Organic sessions (GA4)', v: N(org(C.ga4)), d: delta(org(C.ga4), org(Pv.ga4)) },
      { l: 'Organic conversions', v: N(orgK(C.ga4)), d: delta(orgK(C.ga4), orgK(Pv.ga4)) },
      { l: 'Organic conv. rate', v: P(orgK(C.ga4) / org(C.ga4)), d: delta(orgK(C.ga4) / org(C.ga4), orgK(Pv.ga4) / org(Pv.ga4)) },
      { l: 'AI assistant visits', v: N(sum(C.ai, 'sessions')), d: delta(sum(C.ai, 'sessions'), sum(Pv.ai, 'sessions')) },
    ];
    $('kpis').innerHTML = kpis.map(k => `<div class="kpi${k.lead ? ' lead' : ''}"><span class="lbl">${esc(k.l)}</span><span class="v">${k.v}</span>${hasPrev ? k.d : ''}</div>`).join('');

    const ctx = { C, Pv, hasPrev, inRange, prevKeys };
    const al = alertList(ctx), high = al.filter(a => a.sev === 'High').length;
    const at = $('views').querySelector('[data-v="alerts"]'); at.innerHTML = 'Alerts' + (al.length ? ` <span class="pill ${high ? 'p-loss' : 'p-low'}">${al.length}</span>` : '');
    ctx.alerts = al;
    $('body').innerHTML = ({ overview, pages, blog, landing, queries, markets, new: newPages, technical, speed, ai, paid, alerts })[v](ctx);
    $('body').querySelectorAll('[data-more]').forEach(b => b.onclick = () => { st.open[b.dataset.more] = !st.open[b.dataset.more]; render(); });
    $('body').querySelectorAll('[data-seg]').forEach(b => b.onclick = () => { st[b.dataset.seg] = b.dataset.val; render(); });
    $('body').querySelectorAll('[data-go]').forEach(b => b.onclick = () => { location.hash = '#/' + b.dataset.go; });
    $('body').querySelectorAll('input[data-q]').forEach(inp => inp.oninput = () => { st.q[inp.dataset.q] = inp.value; render(inp.id); });
    $('body').querySelectorAll('[data-find]').forEach(li => li.onclick = () => { st.q.pages = li.dataset.find; render(); });
    ctx.after && ctx.after.forEach(f => f());
    if (focusId) { const el = $(focusId); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  }

  // A ranked table with "Show all"; cols: [{l, f(row) → html, t?(row) → title}]
  function table(id, title, note, cols, list, opts = {}){
    const lim = opts.limit || 15, open = st.open[id], shown = open ? list : list.slice(0, lim);
    return `<section class="panel"${opts.wide ? ' style="grid-column:1/-1"' : ''}><div class="ph"><h2>${esc(title)}</h2><p class="note">${esc(note)}</p></div>${opts.tools || ''}
      <div class="tbl"><table><thead><tr>${cols.map(c => `<th>${esc(c.l)}</th>`).join('')}</tr></thead>
      <tbody>${shown.length ? shown.map(r => `<tr>${cols.map((c, i) => `<td${i === 0 ? ` class="name" title="${esc(c.t ? c.t(r) : '')}"` : c.cls && c.cls(r) ? ` class="${c.cls(r)}"` : ''}>${c.f(r)}</td>`).join('')}</tr>`).join('')
        : `<tr><td colspan="${cols.length}" class="empty">Nothing for this selection</td></tr>`}</tbody></table></div>
      ${list.length > lim ? `<button class="more" type="button" data-more="${id}">${open ? 'Show top ' + lim : 'Show all ' + list.length.toLocaleString('en-US')}</button>` : ''}</section>`;
  }
  const seg = (key, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-seg="${key}" data-val="${v}" aria-pressed="${st[key] === v}">${l}</button>`).join('')}</div>`;
  const gscCols = (hasPrev, prevMap, label) => [
    { l: 'Clicks', f: a => N(a.clicks) }, { l: 'Impressions', f: a => N(a.impressions) },
    { l: 'CTR', f: a => P(ctr(a)) }, { l: 'Position', f: a => POS(pos(a)) },
    ...(hasPrev ? [{ l: 'Clicks vs prior', f: a => delta(a.clicks, prevMap.get(a.k)?.clicks || 0) }] : []),
  ];
  const lineChart = (canvasId, labels, sets) => () => {
    const el = $(canvasId); if (!el) return;
    charts.push(new Chart(el, {
      type: 'line', data: { labels, datasets: sets.map(s => ({ ...s, borderWidth: 2, pointRadius: 0, tension: .25, fill: false })) },
      options: { maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: sets.length > 1, position: 'top', align: 'start', labels: { boxWidth: 10, boxHeight: 10 } },
          tooltip: { callbacks: { label: c => ' ' + c.dataset.label + ': ' + N(c.parsed.y) } } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } }, y: { beginAtZero: true, ticks: { callback: v => N(v) } } } },
    }));
  };
  const dayLabel = (ds, multi) => multi ? MN[+ds.slice(5, 7) - 1] + ' ' + +ds.slice(8) : String(+ds.slice(8));

  // ── Overview ──
  function overview(ctx){
    const { C, Pv, hasPrev, inRange } = ctx;
    // Conversions = GA4 key events from Organic Search sessions; clicks / impressions = Search Console.
    const conv = st.metric === 'conversions';
    const src = conv ? C.ga4.filter(r => r.channel === 'Organic Search') : C.daily, fld = conv ? 'keyEvents' : st.metric;
    const days = [...new Set(src.map(r => r.day))].sort();
    const sites = st.site ? [st.site] : SITES.map(s => s.k);
    const by = {}; src.forEach(r => { const k = r.site + '|' + r.day; by[k] = (by[k] || 0) + (+r[fld] || 0); });
    ctx.after = [lineChart('trend', days.map(d => dayLabel(d, inRange.length > 1)), sites.map(s => ({ label: s, data: days.map(d => by[s + '|' + d] || 0), borderColor: SCOLOR[s], backgroundColor: SCOLOR[s] })))];

    const sc = gscAgg(C.daily, r => r.site), sp = gscAgg(Pv.daily, r => r.site);
    const ga = (rows, s, ch, f) => sum(rows.filter(r => r.site === s && (!ch || r.channel === ch)), f);
    const siteList = sites.map(s => sc.get(s) || { k: s, clicks: 0, impressions: 0, posw: 0 });
    const siteTbl = table('sites', 'By site', 'Search Console + GA4 organic', [
      { l: 'Site', f: a => siteDot(a.k) + esc(a.k), t: a => a.k }, ...gscCols(hasPrev, sp),
      { l: 'Organic sessions', f: a => N(ga(C.ga4, a.k, 'Organic Search', 'sessions')) },
      { l: 'Conversions', f: a => N(ga(C.ga4, a.k, 'Organic Search', 'keyEvents')) },
      { l: 'Conv. rate', f: a => P(ga(C.ga4, a.k, 'Organic Search', 'keyEvents') / ga(C.ga4, a.k, 'Organic Search', 'sessions')) },
    ], siteList);

    const chAgg = rows => { const m = new Map(); rows.forEach(r => { const a = m.get(r.channel) || { k: r.channel, sessions: 0, engaged: 0, keyEvents: 0 }; a.sessions += +r.sessions || 0; a.engaged += +r.engaged || 0; a.keyEvents += +r.keyEvents || 0; m.set(r.channel, a); }); return m; };
    const cc = chAgg(C.ga4), cp = chAgg(Pv.ga4), allS = sum(C.ga4, 'sessions');
    const chTbl = table('channels', 'All traffic by channel (GA4)', N(allS) + ' sessions', [
      { l: 'Channel', f: a => esc(a.k) + (a.k === 'Organic Search' ? ' <span class="pill p-new">SEO</span>' : a.k === 'AI Assistant' ? ' <span class="pill p-sleep">GEO</span>' : ''), t: a => a.k },
      { l: 'Sessions', f: a => N(a.sessions) }, { l: 'Share', f: a => P(a.sessions / allS) },
      { l: 'Engaged', f: a => P(a.engaged / a.sessions) }, { l: 'Key events', f: a => N(a.keyEvents) },
      ...(hasPrev ? [{ l: 'vs prior', f: a => delta(a.sessions, cp.get(a.k)?.sessions || 0) }] : []),
    ], [...cc.values()].sort((a, b) => b.sessions - a.sessions), { limit: 10 });

    const typeAgg = gscAgg(C.pages, r => pageType(r.page)), typeAll = tot(C.pages);
    const types = `<section class="panel"><div class="ph"><h2>Clicks by page type</h2><p class="note">Which kinds of pages bring organic traffic</p></div><div class="sstats">${['Home', 'Landing', 'Blog', 'Site page'].map(t => { const a = typeAgg.get(t) || { clicks: 0 }; return `<div class="stat"><span class="lbl">${t === 'Site page' ? 'Other pages' : t}</span><b>${N(a.clicks)}</b><span class="note">${P(a.clicks / typeAll.clicks)} of clicks</span></div>`; }).join('')}</div></section>`;
    return `<section class="panel"><div class="ph"><h2>${({ clicks: 'Clicks from Google', impressions: 'Impressions in Google results', conversions: 'Conversions from organic search' })[st.metric]} per day</h2><div class="tools">${seg('metric', [['clicks', 'Clicks'], ['impressions', 'Impressions'], ['conversions', 'Conversions']])}<p class="note">${conv ? 'GA4 key events from Organic Search sessions · lags about 1 day' : 'Search Console · data lags about 2 days'}</p></div></div><div class="chart"><canvas id="trend"></canvas></div></section>${types}
      ${siteTbl}${chTbl}`;
  }

  // ── Pages ──
  function pages(ctx){
    const { C, Pv, hasPrev } = ctx;
    const cur = gscAgg(C.pages, r => r.page), prev = gscAgg(Pv.pages, r => r.page);
    const label = u => { try { const x = new URL(u); return (st.site ? '' : x.host.replace(/^www\./, '')) + x.pathname + x.search; } catch { return u; } };
    const q = st.q.pages.trim().toLowerCase();
    let list = [...cur.values()].map(a => ({ ...a, type: pageType(a.k), label: label(a.k) }));
    const typeCount = t => list.filter(a => a.type === t).reduce((s, a) => s + a.clicks, 0);
    if (st.ptype) list = list.filter(a => a.type === st.ptype);
    if (q) list = list.filter(a => a.label.toLowerCase().includes(q));
    list.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

    let movers = '';
    if (hasPrev) {
      const ch = [...new Set([...cur.keys(), ...prev.keys()])].map(k => ({ k, d: (cur.get(k)?.clicks || 0) - (prev.get(k)?.clicks || 0) }))
        .filter(x => !st.ptype || pageType(x.k) === st.ptype);
      const up = ch.filter(x => x.d > 0).sort((a, b) => b.d - a.d).slice(0, 8), dn = ch.filter(x => x.d < 0).sort((a, b) => a.d - b.d).slice(0, 8);
      const li = x => `<li data-find="${esc(label(x.k))}" title="${esc(x.k)}"><span>${esc(label(x.k))}</span><span class="${x.d > 0 ? 'up' : 'down'}">${x.d > 0 ? '+' : '−'}${N(Math.abs(x.d))}</span></li>`;
      movers = `<section class="panel"><div class="ph"><h2>Biggest movers</h2><p class="note">Change in clicks vs prior period · click a page to find it below</p></div>
        <div class="movers"><div><h3>Gaining</h3><ol>${up.map(li).join('') || '<li><span>None</span></li>'}</ol></div><div><h3>Losing</h3><ol>${dn.map(li).join('') || '<li><span>None</span></li>'}</ol></div></div></section>`;
    }
    const tools = `<div class="tools">${seg('ptype', [['', 'All'], ['Home', 'Home'], ['Landing', 'Landing'], ['Blog', 'Blog'], ['Site page', 'Other pages']])}
      <input type="search" id="q-pages" data-q="pages" placeholder="Find a page" value="${esc(st.q.pages)}" aria-label="Find a page"></div>`;
    const stats = `<section class="panel"><div class="sstats">${['Home', 'Landing', 'Blog', 'Site page'].map(t => `<div class="stat"><span class="lbl">${t === 'Site page' ? 'Other pages' : t} clicks</span><b>${N(typeCount(t))}</b></div>`).join('')}</div></section>`;
    return stats + movers + table('pages', 'Pages in Google results', `${list.length.toLocaleString('en-US')} pages · Search Console, top pages per site per month`, [
      { l: 'Page', f: a => siteDot(a.r.site) + esc(a.label), t: a => a.k }, { l: 'Type', f: a => esc(a.type) }, ...gscCols(hasPrev, prev),
    ], list, { limit: 25, tools });
  }

  // ── Queries ──
  function queries(ctx){
    const { C, Pv, hasPrev } = ctx;
    const key = r => r.site + '|' + r.query;
    const cur = gscAgg(C.queries, key), prev = gscAgg(Pv.queries, key);
    const all = [...cur.values()].map(a => ({ ...a, brand: BRAND_RE.test(a.r.query) }));
    const brand = all.filter(a => a.brand), non = all.filter(a => !a.brand);
    const bc = brand.reduce((s, a) => s + a.clicks, 0), nc = non.reduce((s, a) => s + a.clicks, 0);
    const strike = non.filter(a => pos(a) >= 4 && pos(a) <= 20 && a.impressions >= 20).sort((a, b) => b.impressions - a.impressions);
    const qs = all.filter(a => QUESTION_RE.test(a.r.query));
    const stats = `<section class="panel"><div class="sstats">
      <div class="stat"><span class="lbl">Non-brand clicks</span><b>${N(nc)}</b></div>
      <div class="stat"><span class="lbl">Non-brand share</span><b>${P(nc / (nc + bc))}</b></div>
      <div class="stat"><span class="lbl">Brand clicks</span><b>${N(bc)}</b></div>
      <div class="stat"><span class="lbl">Striking distance</span><b>${N(strike.length)}</b></div>
      <div class="stat"><span class="lbl">Question searches</span><b>${N(qs.length)}</b></div></div></section>`;
    const qcell = { l: 'Query', f: a => siteDot(a.r.site) + esc(a.r.query), t: a => a.r.query };
    const strikeTbl = table('strike', 'Striking distance', 'Non-brand queries at position 4–20: a push could reach the top 3', [
      qcell, { l: 'Impressions', f: a => N(a.impressions) }, { l: 'Clicks', f: a => N(a.clicks) }, { l: 'Position', f: a => POS(pos(a)) }, { l: 'CTR', f: a => P(ctr(a)) },
    ], strike, { limit: 15 });
    const q = st.q.queries.trim().toLowerCase();
    let list = st.brand === 'brand' ? brand : st.brand === 'nonbrand' ? non : all;
    if (q) list = list.filter(a => a.r.query.toLowerCase().includes(q));
    list = list.slice().sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    const tools = `<div class="tools">${seg('brand', [['nonbrand', 'Non-brand'], ['brand', 'Brand'], ['', 'All']])}
      <input type="search" id="q-queries" data-q="queries" placeholder="Find a query" value="${esc(st.q.queries)}" aria-label="Find a query"></div>`;
    return stats + strikeTbl + `${table('queries', 'Search queries', list.length.toLocaleString('en-US') + ' queries · anonymised queries are not reported by Google', [qcell, ...gscCols(hasPrev, prev)], list, { limit: 15, tools })}`;
  }

  // ── Markets ──
  function markets(ctx){
    const { C, Pv, hasPrev } = ctx;
    const t = tot(C.markets);
    const share = { l: 'Share of clicks', f: a => P(a.clicks / t.clicks) };
    const cc = gscAgg(C.markets, r => r.country), cp = gscAgg(Pv.markets, r => r.country);
    const dc = gscAgg(C.markets, r => r.device), dp = gscAgg(Pv.markets, r => r.device);
    const sort = m => [...m.values()].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    const cname = c => COUNTRY[c] || String(c).toUpperCase();
    const dname = d => ({ DESKTOP: 'Desktop', MOBILE: 'Mobile', TABLET: 'Tablet' }[d] || d);
    return `${table('countries', 'By country', cc.size + ' countries · where searchers are', [{ l: 'Country', f: a => esc(cname(a.k)), t: a => cname(a.k) }, ...gscCols(hasPrev, cp), share], sort(cc), { limit: 15 })}
      ${table('devices', 'By device', 'Search Console', [{ l: 'Device', f: a => esc(dname(a.k)) }, ...gscCols(hasPrev, dp), share], sort(dc))}`;
  }

  // ── AI search (GEO) ──
  function ai(ctx){
    const { C, Pv, hasPrev, inRange } = ctx;
    const allS = sum(C.ga4, 'sessions'), aiS = sum(C.ai, 'sessions'), aiK = sum(C.ai, 'keyEvents');
    const agg = (rows, kf) => { const m = new Map(); rows.forEach(r => { const k = kf(r); const a = m.get(k) || { k, r, sessions: 0, engaged: 0, keyEvents: 0 }; a.sessions += +r.sessions || 0; a.engaged += +r.engaged || 0; a.keyEvents += +r.keyEvents || 0; m.set(k, a); }); return [...m.values()].sort((a, b) => b.sessions - a.sessions); };
    const src = agg(C.ai, r => r.source), srcP = new Map(agg(Pv.ai, r => r.source).map(a => [a.k, a]));
    const lp = agg(C.ai, r => r.host + r.page);
    const staging = lp.filter(a => STAGING_RE.test(a.r.host));
    const qs = [...gscAgg(C.queries.filter(r => QUESTION_RE.test(r.query)), r => r.site + '|' + r.query).values()].sort((a, b) => b.impressions - a.impressions);

    const days = [...new Set(C.ga4.map(r => r.day))].sort(), by = {};
    C.ga4.filter(r => r.channel === 'AI Assistant').forEach(r => by[r.day] = (by[r.day] || 0) + (+r.sessions || 0));
    ctx.after = [lineChart('aitrend', days.map(d => dayLabel(d, inRange.length > 1)), [{ label: 'AI Assistant sessions', data: days.map(d => by[d] || 0), borderColor: '#5A5F86', backgroundColor: '#5A5F86' }])];

    const stats = `<section class="panel"><div class="sstats">
      <div class="stat"><span class="lbl">Visits from AI assistants</span><b>${N(aiS)}</b></div>
      <div class="stat"><span class="lbl">Share of all sessions</span><b>${P(aiS / allS)}</b></div>
      <div class="stat"><span class="lbl">Key events</span><b>${N(aiK)}</b></div>
      <div class="stat"><span class="lbl">Engaged</span><b>${P(sum(C.ai, 'engaged') / aiS)}</b></div>
      <div class="stat"><span class="lbl">Landings on staging</span><b${staging.length ? ' class="down"' : ''}>${N(staging.reduce((s, a) => s + a.sessions, 0))}</b></div></div></section>`;
    const warn = staging.length ? `<div class="banner">AI assistants are sending visitors to a staging site (${esc([...new Set(staging.map(a => a.r.host))].join(', '))}). Block it from crawlers (noindex / password) and point those links to the live site.</div>` : '';
    const sessCols = [{ l: 'Sessions', f: a => N(a.sessions) }, { l: 'Engaged', f: a => P(a.engaged / a.sessions) }, { l: 'Key events', f: a => N(a.keyEvents) }];
    return stats + warn + `<section class="panel"><div class="ph"><h2>AI Assistant sessions per day</h2><p class="note">GA4 channel group "AI Assistant"</p></div><div class="chart"><canvas id="aitrend"></canvas></div></section>
      <div class="grid2">${table('aisrc', 'By assistant', 'Session source (ChatGPT, Perplexity, Gemini, Copilot, Claude…)', [{ l: 'Source', f: a => esc(a.k), t: a => a.k }, ...sessCols, { l: 'Share', f: a => P(a.sessions / aiS) }, ...(hasPrev ? [{ l: 'vs prior', f: a => delta(a.sessions, srcP.get(a.k)?.sessions || 0) }] : [])], src, { limit: 10 })}
      ${table('ailp', 'Where AI visitors land', 'Landing page (GA4)', [{ l: 'Page', f: a => siteDot(a.r.site) + esc(a.r.host.replace(/^www\./, '') + a.r.page) + (STAGING_RE.test(a.r.host) ? ' <span class="pill p-loss">staging</span>' : ''), t: a => a.r.host + a.r.page }, ...sessCols], lp, { limit: 10 })}</div>
      ${table('aiq', 'Question-style searches on Google', 'The kind of questions people also ask AI assistants: answer them clearly on the page', [{ l: 'Query', f: a => siteDot(a.r.site) + esc(a.r.query), t: a => a.r.query }, { l: 'Impressions', f: a => N(a.impressions) }, { l: 'Clicks', f: a => N(a.clicks) }, { l: 'Position', f: a => POS(pos(a)) }], qs, { limit: 15, wide: true })}`;
  }

  // ── Shared for the views below ──
  const passSt = r => !st.site || r.site === st.site;
  const plabel = u => { try { const x = new URL(u); return (st.site ? '' : x.host.replace(/^www\./, '')) + x.pathname + x.search; } catch { return String(u); } };
  const pathOf = u => { try { const x = new URL(u); return x.host.replace(/^www\./, '') + x.pathname; } catch { return String(u); } };
  const pcell = (u, site) => ({ l: 'Page', f: r => siteDot(site(r)) + esc(plabel(u(r))), t: r => u(r) });
  const pill = (t, c) => `<span class="pill ${c}">${esc(t)}</span>`;
  const panel = (title, note, html) => `<section class="panel"><div class="ph"><h2>${esc(title)}</h2><p class="note">${esc(note)}</p></div>${html}</section>`;
  const stats = list => `<section class="panel"><div class="sstats">${list.map(([l, v, bad]) => `<div class="stat"><span class="lbl">${esc(l)}</span><b${bad ? ' class="down"' : ''}>${v}</b></div>`).join('')}</div></section>`;
  const dateFmt = d => d ? new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  const daysSince = d => d ? Math.max(0, Math.round((Date.now() - new Date(String(d).slice(0, 10) + 'T12:00:00')) / 864e5)) : NaN;
  const idxCls = r => !r.verdict ? '' : r.verdict === 'PASS' ? 'good' : r.verdict === 'FAIL' ? 'bad' : 'warn';
  const idxText = r => esc(r.coverage || r.verdict || '—');
  const syncedNote = (d, what) => d.synced ? what + ' · checked ' + dateFmt(d.synced) : what;
  const noAudit = what => panel(what, 'Not run yet', `<p class="empty">No results yet. These checks come from the weekly ${what === 'Speed' ? 'speedSync()' : 'auditSync()'} in sync/SeoSync.gs.</p>`);
  const barChart = (canvasId, labels, values, color) => () => {
    const el = $(canvasId); if (!el) return;
    charts.push(new Chart(el, { type: 'bar', data: { labels, datasets: [{ data: values, backgroundColor: color, borderRadius: 3 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + N(c.parsed.x) + ' clicks' } } },
        scales: { x: { beginAtZero: true, ticks: { callback: v => N(v) } }, y: { grid: { display: false }, ticks: { callback: function (v) { const s = this.getLabelForValue(v); return s.length > 48 ? s.slice(0, 47) + '…' : s; } } } } } }));
  };

  // ── Blog ──
  function blog(ctx){
    const { C, Pv, hasPrev } = ctx;
    const isBlog = r => pageType(r.page) === 'Blog';
    const cur = gscAgg(C.pages.filter(isBlog), r => r.page), prev = gscAgg(Pv.pages.filter(isBlog), r => r.page);
    const list = [...cur.values()].map(a => {
      const p = prev.get(a.k)?.clicks || 0, ps = pos(a), flags = [];
      if (hasPrev && p >= 10 && a.clicks < p * 0.8) flags.push(['Decaying', 'p-loss']);
      if (a.impressions >= 1000 && ctr(a) < 0.01) flags.push(['Low CTR', 'p-low']);
      if (ps >= 11 && ps <= 20) flags.push(['Page 2', 'p-sleep']);
      return { ...a, flags };
    }).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    const has = f => list.filter(a => a.flags.some(x => x[0] === f)).length;
    const top = list.slice(0, 10);
    ctx.after = [barChart('blogtop', top.map(a => plabel(a.k)), top.map(a => a.clicks), '#EE7805')];
    return stats([['Posts in Google', N(list.length)], ['Blog clicks', N(list.reduce((s, a) => s + a.clicks, 0))], ['Decaying', N(has('Decaying')), has('Decaying') > 0], ['Low CTR', N(has('Low CTR'))], ['On page 2', N(has('Page 2'))]])
      + panel('Top blog posts', 'Organic clicks', `<div class="chart" style="height:${Math.max(160, top.length * 30 + 40)}px"><canvas id="blogtop"></canvas></div>`)
      + table('blog', 'Blog posts in Google Search', 'Decaying: clicks down over 20% vs prior period. Low CTR: under 1% on 1,000+ impressions. Page 2: position 11–20.', [
        pcell(a => a.k, a => a.r.site), ...gscCols(hasPrev, prev), { l: 'Flags', f: a => a.flags.map(([t, c]) => pill(t, c)).join('') || '—' }], list, { limit: 25 });
  }

  // ── Landing pages ──
  function landing(ctx){
    const { C, Pv, hasPrev } = ctx;
    const isLp = r => pageType(r.page) === 'Landing';
    const cur = gscAgg(C.pages.filter(isLp), r => r.page), prev = gscAgg(Pv.pages.filter(isLp), r => r.page);
    const gsc = [...cur.values()].sort((a, b) => b.clicks - a.clicks);
    const rows = C.landing.filter(r => st.lpOnly !== 'yes' || pageType('https://' + r.host + r.page) === 'Landing');
    const m = new Map();
    rows.forEach(r => {
      const k = r.host + r.page, a = m.get(k) || { k, r, sessions: 0, organic: 0, search: 0, social: 0, other: 0, engaged: 0, keyEvents: 0 };
      const s = +r.sessions || 0; a.sessions += s; a.engaged += +r.engaged || 0; a.keyEvents += +r.keyEvents || 0;
      if (r.channel === 'Organic Search') a.organic += s; else if (r.channel === 'Paid Search') a.search += s; else if (/^Paid (Social|Other|Video)|Cross-network|Display/.test(r.channel)) a.social += s; else a.other += s;
      m.set(k, a);
    });
    const ga = [...m.values()].sort((a, b) => b.sessions - a.sessions);
    const tools = `<div class="tools">${seg('lpOnly', [['yes', 'Landing pages'], ['no', 'All pages']])}</div>`;
    return stats([['Landing pages in Google', N(gsc.length)], ['Organic clicks', N(gsc.reduce((s, a) => s + a.clicks, 0))], ['GA4 sessions', N(ga.reduce((s, a) => s + a.sessions, 0))], ['Key events', N(ga.reduce((s, a) => s + a.keyEvents, 0))]])
      + table('lpga', 'Traffic and conversions by landing page (GA4)', 'All channels. Landing pages: lp. subdomains or /lp/, /landing/, /go/, /promo/, /offer/ paths', [
        { l: 'Page', f: a => siteDot(a.r.site) + esc((st.site ? '' : a.r.host.replace(/^www\./, '')) + a.r.page), t: a => a.r.host + a.r.page },
        { l: 'Sessions', f: a => N(a.sessions) }, { l: 'Organic', f: a => N(a.organic) }, { l: 'Paid search', f: a => N(a.search) }, { l: 'Paid social / other paid', f: a => N(a.social) }, { l: 'Other', f: a => N(a.other) },
        { l: 'Key events', f: a => N(a.keyEvents) }, { l: 'Key-event rate', f: a => P(a.keyEvents / a.sessions) }], ga, { limit: 20, tools })
      + table('lpgsc', 'Landing pages in Google Search', 'Organic only (Search Console)', [pcell(a => a.k, a => a.r.site), ...gscCols(hasPrev, prev)], gsc, { limit: 15 });
  }

  // ── New pages ──
  function newPages(ctx){
    const { C, inRange } = ctx;
    const au = data.audit.rows.filter(passSt).filter(r => r.is_new === 'Yes').sort((a, b) => String(b.first_impression).localeCompare(String(a.first_impression)));
    const auTbl = au.length ? table('newau', 'New pages: how fast Google found them', syncedNote(data.audit, 'First impression in the last 90 days, never seen before that'), [
      pcell(r => r.url, r => r.site), { l: 'First impression', f: r => dateFmt(r.first_impression) }, { l: 'Days since', f: r => N(daysSince(r.first_impression)) },
      { l: 'Google index', f: idxText, cls: idxCls }, { l: 'Impressions to date', f: r => N(r.impr_to_date) }, { l: 'Clicks to date', f: r => N(r.clicks_to_date) }], au, { limit: 20 }) : noAudit('New pages');
    // From the monthly page lists: pages whose first month with impressions falls in the selected period.
    const first = {};
    keys.forEach(k => (data.pages.months[k] || []).forEach(r => { if (!(r.page in first)) first[r.page] = k; }));
    const fresh = gscAgg(C.pages.filter(r => first[r.page] > keys[0] && inRange.includes(first[r.page])), r => r.page);
    const list = [...fresh.values()].sort((a, b) => b.impressions - a.impressions);
    return auTbl + table('newm', 'Pages first seen in this period', 'Not in Google results in any earlier month we have', [
      pcell(a => a.k, a => a.r.site), { l: 'First month', f: a => esc(monthName(first[a.k])) }, { l: 'Clicks', f: a => N(a.clicks) }, { l: 'Impressions', f: a => N(a.impressions) }, { l: 'Position', f: a => POS(pos(a)) }], list, { limit: 20 });
  }

  // ── Technical ──
  function technical(){
    const rows = data.audit.rows.filter(passSt);
    if (!rows.length) return noAudit('Technical health');
    const score = r => (+r.status >= 400 ? 16 : 0) + (r.noindex === 'Yes' ? 8 : 0) + (r.verdict === 'FAIL' ? 4 : r.verdict && r.verdict !== 'PASS' ? 2 : 0) + (+r.desc_len === 0 ? 2 : 0) + (+r.h1 !== 1 ? 1 : 0) + (+r.title_len < 25 || +r.title_len > 60 ? 1 : 0);
    const list = rows.slice().sort((a, b) => score(b) - score(a) || (+b.clicks28 || 0) - (+a.clicks28 || 0));
    const c = f => rows.filter(f).length, ok = r => +r.status < 300;
    return stats([['Pages checked', N(rows.length)], ['Errors (4xx/5xx)', N(c(r => +r.status >= 400)), c(r => +r.status >= 400) > 0], ['Redirects', N(c(r => +r.status >= 300 && +r.status < 400))],
        ['Noindex', N(c(r => r.noindex === 'Yes')), c(r => r.noindex === 'Yes') > 0], ['Not indexed', N(c(r => r.verdict && r.verdict !== 'PASS'))], ['No meta description', N(c(r => ok(r) && +r.desc_len === 0))], ['H1 issues', N(c(r => ok(r) && +r.h1 !== 1))]])
      + table('tech', 'On-page and technical checks', syncedNote(data.audit, 'Titles 25–60 characters, descriptions 70–160, one H1 per page'), [
        pcell(r => r.url, r => r.site),
        { l: 'Status', f: r => esc(r.status) + (r.location ? ' →' : ''), cls: r => +r.status >= 400 ? 'bad' : +r.status >= 300 ? 'warn' : '' },
        { l: 'Google index', f: idxText, cls: idxCls }, { l: 'Noindex', f: r => esc(r.noindex || '—'), cls: r => r.noindex === 'Yes' ? 'bad' : '' },
        { l: 'Title', f: r => ok(r) ? N(r.title_len) : '—', cls: r => ok(r) && (+r.title_len < 25 || +r.title_len > 60) ? 'warn' : '' },
        { l: 'Description', f: r => ok(r) ? N(r.desc_len) : '—', cls: r => !ok(r) ? '' : +r.desc_len === 0 ? 'bad' : (+r.desc_len < 70 || +r.desc_len > 160) ? 'warn' : '' },
        { l: 'H1', f: r => ok(r) ? N(r.h1) : '—', cls: r => ok(r) && +r.h1 !== 1 ? 'warn' : '' },
        { l: 'Images no alt', f: r => ok(r) ? N(r.img_no_alt) : '—', cls: r => +r.img_no_alt > 0 ? 'warn' : '' },
        { l: 'Words', f: r => ok(r) ? N(r.words) : '—' }, { l: 'Clicks (28 days)', f: r => N(r.clicks28) }], list, { limit: 25 });
  }

  // ── Speed ──
  function speed(){
    const all = data.speed.rows.filter(passSt);
    if (!all.length) return noAudit('Speed');
    const rows = all.filter(r => r.strategy === st.strategy).sort((a, b) => a.performance - b.performance);
    const perf = rows.map(r => +r.performance).sort((a, b) => a - b), med = perf.length ? perf[Math.floor(perf.length / 2)] : NaN;
    const tools = `<div class="tools">${seg('strategy', [['mobile', 'Mobile'], ['desktop', 'Desktop']])}</div>`;
    const tri = (v, good, bad) => +v > bad ? 'bad' : +v > good ? 'warn' : 'good';
    return stats([['Median performance', isFinite(med) ? N(med) : '—'], ['Pages under 50', N(rows.filter(r => +r.performance < 50).length), rows.some(r => +r.performance < 50)], ['Slow for real users', N(rows.filter(r => r.field_rating === 'Slow').length)], ['Pages tested', N(rows.length)]])
      + table('speed', 'PageSpeed and Core Web Vitals', syncedNote(data.speed, 'Good: LCP under 2.5 s, CLS under 0.1, INP under 200 ms'), [
        pcell(r => r.url, r => r.site),
        { l: 'Performance', f: r => N(r.performance), cls: r => +r.performance < 50 ? 'bad' : +r.performance < 90 ? 'warn' : 'good' },
        { l: 'SEO', f: r => N(r.seo) }, { l: 'Accessibility', f: r => N(r.accessibility) },
        { l: 'LCP (s)', f: r => (+r.lcp_s).toFixed(1), cls: r => tri(r.lcp_s, 2.5, 4) }, { l: 'CLS', f: r => (+r.cls).toFixed(2), cls: r => tri(r.cls, 0.1, 0.25) },
        { l: 'INP real users (ms)', f: r => r.field_inp_ms ? N(r.field_inp_ms) : '—', cls: r => r.field_inp_ms ? tri(r.field_inp_ms, 200, 500) : '' },
        { l: 'Real-user rating', f: r => esc(r.field_rating || 'Not enough data'), cls: r => r.field_rating === 'Slow' ? 'bad' : r.field_rating === 'Average' ? 'warn' : r.field_rating === 'Fast' ? 'good' : '' }], rows, { limit: 25, tools });
  }

  // ── Paid vs organic ──
  function paid(ctx){
    const { C, Pv, hasPrev, inRange, prevKeys } = ctx;
    if (!st.paid && !st.paidErr) {
      if (!st.paidLoading) { st.paidLoading = true; getPaid(keys[0] + '-01').then(p => { st.paid = paidRows(p); render(); }).catch(e => { console.error(e); st.paidErr = /permission|insufficient/i.test(e.message || '') ? 'Firestore refused access to the ad data.' : 'The ad data could not load.'; render(); }); }
      return panel('Paid vs organic', 'Loading the Google Ads and Meta data…', '<p class="empty">Loading…</p>');
    }
    const inM = ks => r => ks.includes(String(r.day).slice(0, 7));
    const pr = (st.paid || []).filter(passSt), pc = pr.filter(inM(inRange)), pp = pr.filter(inM(prevKeys));
    const isPaid = ch => /^Paid|Cross-network|Display/.test(ch);
    const days = [...new Set(C.ga4.map(r => r.day))].sort(), series = [['Organic Search', '#1E7F4F', r => r.channel === 'Organic Search'], ['Paid Search', '#EE7805', r => r.channel === 'Paid Search'], ['Paid social & other paid', '#3A6EA5', r => isPaid(r.channel) && r.channel !== 'Paid Search']];
    ctx.after = [lineChart('paidtrend', days.map(d => dayLabel(d, inRange.length > 1)), series.map(([l, c, f]) => { const by = {}; C.ga4.filter(f).forEach(r => by[r.day] = (by[r.day] || 0) + (+r.sessions || 0)); return { label: l, data: days.map(d => by[d] || 0), borderColor: c, backgroundColor: c }; }))];
    const sites = st.site ? [st.site] : SITES.map(s => s.k);
    const g = (rows, s, f, m) => sum(rows.filter(r => r.site === s && f(r.channel)), m);
    const bySite = sites.map(s => {
      const spend = sum(pc.filter(r => r.site === s), 'usd'), pke = g(C.ga4, s, isPaid, 'keyEvents'), oke = g(C.ga4, s, ch => ch === 'Organic Search', 'keyEvents');
      return { k: s, os: g(C.ga4, s, ch => ch === 'Organic Search', 'sessions'), oke, ps: g(C.ga4, s, isPaid, 'sessions'), pke, spend, cpa: pke && spend ? spend / pke : NaN, spendPrev: sum(pp.filter(r => r.site === s), 'usd') };
    });
    const usd = v => isFinite(v) ? '$' + Math.round(v).toLocaleString('en-US') : '—';
    const T = f => bySite.reduce((s, a) => s + (a[f] || 0), 0);
    const plat = ['Google Ads', 'Meta'].map(p => { const r = pc.filter(x => x.platform === p); return { k: p, spend: sum(r, 'usd'), clicks: sum(r, 'clicks'), conv: sum(r, 'conversions'), prev: sum(pp.filter(x => x.platform === p), 'usd') }; });
    return (st.paidErr ? `<div class="banner">${esc(st.paidErr)} Spend columns are empty; sessions still come from GA4.</div>` : '')
      + stats([['Organic sessions', N(T('os'))], ['Paid sessions', N(T('ps'))], ['Organic share', P(T('os') / (T('os') + T('ps')))], ['Ad spend', usd(T('spend'))], ['Organic key events', N(T('oke'))], ['Paid key events', N(T('pke'))]])
      + panel('Sessions per day: organic vs paid', 'GA4 default channel groups', '<div class="chart"><canvas id="paidtrend"></canvas></div>')
      + table('paidsite', 'By site', 'Spend from the Google Ads and Meta syncs (USD). Organic value = organic key events × your paid cost per key event.', [
        { l: 'Site', f: a => siteDot(a.k) + esc(a.k), t: a => a.k }, { l: 'Organic sessions', f: a => N(a.os) }, { l: 'Organic key events', f: a => N(a.oke) },
        { l: 'Paid sessions', f: a => N(a.ps) }, { l: 'Paid key events', f: a => N(a.pke) }, { l: 'Ad spend', f: a => usd(a.spend) },
        ...(hasPrev ? [{ l: 'Spend vs prior', f: a => delta(a.spend, a.spendPrev) }] : []),
        { l: 'Paid cost / key event', f: a => usd(a.cpa) }, { l: 'Organic value', f: a => usd(a.oke * a.cpa) }], bySite)
      + table('paidplat', 'Ad platforms', 'Clicks and conversions as reported by each platform', [
        { l: 'Platform', f: a => esc(a.k) }, { l: 'Spend', f: a => usd(a.spend) }, ...(hasPrev ? [{ l: 'vs prior', f: a => delta(a.spend, a.prev) }] : []),
        { l: 'Clicks', f: a => N(a.clicks) }, { l: 'Conversions', f: a => N(a.conv) }, { l: 'Cost / conversion', f: a => usd(a.conv ? a.spend / a.conv : NaN) }], plat)
      + '<p class="note">GlobuSIM has no ad account in the Ads/Meta syncs, so its spend shows $0.</p>';
  }

  // ── Alerts ──
  function alertList({ C, Pv, hasPrev }){
    const out = [], add = (sev, site, cat, path, issue) => out.push({ sev, site, cat, path, issue });
    if (hasPrev) {
      const sc = gscAgg(C.daily, r => r.site), sp = gscAgg(Pv.daily, r => r.site);
      sp.forEach((p, s) => { const c = sc.get(s)?.clicks || 0; if (p.clicks >= 100 && c < p.clicks * 0.8) add(c < p.clicks * 0.6 ? 'High' : 'Medium', s, 'Traffic', '(whole site)', `Clicks down ${Math.round((1 - c / p.clicks) * 100)}% vs prior period (${N(p.clicks)} → ${N(c)})`); });
      const pc = gscAgg(C.pages, r => r.page), pp = gscAgg(Pv.pages, r => r.page);
      pp.forEach((p, u) => { const c = pc.get(u)?.clicks || 0; if (p.clicks >= 50 && c < p.clicks * 0.6) add(pageType(u) === 'Home' ? 'High' : 'Medium', p.r.site, 'Traffic', pathOf(u), `Clicks down ${Math.round((1 - c / p.clicks) * 100)}% (${N(p.clicks)} → ${N(c)})`); });
    }
    const stg = new Map(); C.ai.filter(r => STAGING_RE.test(r.host)).forEach(r => stg.set(r.host, { site: r.site, n: (stg.get(r.host)?.n || 0) + (+r.sessions || 0) }));
    stg.forEach((v, h) => add('High', v.site, 'AI search', h, `AI assistants sent ${N(v.n)} visits to this staging site`));
    data.audit.rows.filter(passSt).forEach(r => {
      const p = pathOf(r.url), traffic = +r.clicks28 > 0;
      if (+r.status >= 400) add('High', r.site, 'Technical', p, `Returns HTTP ${r.status}`);
      else if (+r.status >= 300 && traffic) add('Low', r.site, 'Technical', p, `Redirects (${r.status})${r.location ? ' to ' + r.location : ''}`);
      if (r.noindex === 'Yes') add(traffic ? 'High' : 'Medium', r.site, 'Indexing', p, 'Page is marked noindex');
      if (r.verdict && r.verdict !== 'PASS' && (traffic || (r.is_new === 'Yes' && daysSince(r.first_impression) > 14))) add('Medium', r.site, 'Indexing', p, 'Google: ' + (r.coverage || r.verdict));
      if (+r.status && +r.status < 300) {
        if (+r.desc_len === 0) add('Medium', r.site, 'On-page', p, 'No meta description');
        if (+r.h1 !== 1) add('Low', r.site, 'On-page', p, `${r.h1} H1 headings (should be 1)`);
        if (+r.title_len < 25 || +r.title_len > 60) add('Low', r.site, 'On-page', p, `Title is ${r.title_len} characters (aim for 25–60)`);
      }
    });
    data.speed.rows.filter(passSt).filter(r => r.strategy === 'mobile').forEach(r => {
      if (+r.performance < 50) add('Medium', r.site, 'Speed', pathOf(r.url), `Mobile PageSpeed score ${r.performance}/100`);
      if (r.field_rating === 'Slow') add('Medium', r.site, 'Speed', pathOf(r.url), 'Real users find this page slow (Chrome data)');
    });
    const rank = { High: 0, Medium: 1, Low: 2 };
    return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
  }
  function alerts(ctx){
    const al = ctx.alerts, n = s => al.filter(a => a.sev === s).length;
    const cls = { High: 'p-loss', Medium: 'p-low', Low: 'p-sleep' };
    return stats([['High', N(n('High')), n('High') > 0], ['Medium', N(n('Medium'))], ['Low', N(n('Low'))]])
      + table('alerts', 'Open issues', 'Traffic drops vs prior period, staging links, broken or noindexed pages, indexing, on-page and speed issues; most severe first', [
        { l: 'Severity', f: a => pill(a.sev, cls[a.sev]) }, { l: 'Site', f: a => siteDot(a.site) + esc(a.site) }, { l: 'Category', f: a => esc(a.cat) },
        { l: 'Page', f: a => esc(a.path) }, { l: 'Issue', f: a => esc(a.issue) }], al, { limit: 40 });
  }

  render();
}
