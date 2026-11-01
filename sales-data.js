// Shared by sales.html and vnumber.html: Firebase login, reading the monthly
// Package Profitability workbook, and saving/loading it in Firestore.
//   mkt_sales/{YYYY-MM}   one doc per month: rows = JSON of [market, type, package, subscribers, minutes, charged, cost]
//   mkt_salesMeta/last    who uploaded what, when
//   mkt_vnumber/summary   the "Vnumber Summary" tab: months = JSON {YYYY-MM: {rev, newSales, spend, subs, newSubs}}
//   mkt_vnumber/ltv       the "LTV" tab: months = JSON [YYYY-MM…], rows = JSON {country: [ltv…]}, total = JSON [ltv…]
// Sales figures are never committed to the repo (.gitignore blocks *.xlsx and preview files).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore, collection, doc, getDocs, getDoc, writeBatch, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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
// Local-only preview (?preview on localhost): no sign-in; the page reads a
// gitignored test-report.xlsx next to it and uploads stay in memory.
export const LOCAL_PREVIEW = ['localhost','127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('preview');

const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const monthName = k => { const [y, m] = k.split('-'); return MN[+m - 1] + ' ' + y; };
const key = (y, m) => y + '-' + String(m + 1).padStart(2, '0');
const num = v => { if (v == null || v === '') return null; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,%\s]/g, '')); return isFinite(n) ? n : null; };
const $ = id => document.getElementById(id);
let toastT;
export const toast = m => { const el = $('toast'); el.textContent = m; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 6000); };

// ── Reading the workbook ──
// Main tab. Rules: Bglobal = BGlobal; both renewal types count as Monthly.
function parseSales(ws){
  const json = XLSX.utils.sheet_to_json(ws, { defval: null });
  const need = ['Date','Market','Type','Package Name','Subscribers','Minutes','Charged','Cost'];
  const miss = need.filter(c => !json.length || !(c in json[0]));
  if (miss.length) throw new Error('The PackagesProfitability tab is missing these columns: ' + miss.join(', ') + '.');
  const months = {};
  for (const x of json) {
    let d = x.Date; if (!d) continue;
    if (!(d instanceof Date)) d = new Date(d);
    if (isNaN(d)) continue;
    d = new Date(d.getTime() + 12 * 3600e3);
    let mk = String(x.Market ?? '').trim(); if (mk.toLowerCase() === 'bglobal') mk = 'BGlobal';
    let ty = String(x.Type ?? '').trim(); if (ty.startsWith('Renewal')) ty = 'Monthly';
    const pk = String(x['Package Name'] ?? '').trim();
    if (!mk || !pk) continue;
    (months[key(d.getFullYear(), d.getMonth())] ||= []).push([mk, ty, pk, Math.round(num(x.Subscribers) || 0), Math.round(num(x.Minutes) || 0), Math.round((num(x.Charged) || 0) * 100) / 100, Math.round((num(x.Cost) || 0) * 100) / 100]);
  }
  return months;
}

// "Vnumber Summary": row 1 = year (only where it changes), row 2 = month names, column A = labels.
// Only the inputs are kept; churn, CPA, recurring etc. are recalculated on the page with the sheet's formulas.
const SUMMARY_ROWS = { 'revenue': 'rev', 'monthly sales': 'newSales', 'marketing spend': 'spend', 'total suscribers': 'subs', 'total subscribers': 'subs', 'monthly new suscribers': 'newSubs', 'monthly new subscribers': 'newSubs' };
function parseSummary(ws){
  const a = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  if (a.length < 3) return null;
  const cols = []; let year = null;
  for (let c = 1; c < a[1].length; c++) {
    const y = num(a[0][c]); if (y && y > 2000) year = y;
    const m = MN.indexOf(String(a[1][c] ?? '').trim().slice(0, 3));
    if (year && m >= 0) cols.push([c, key(year, m)]);
  }
  const months = {};
  for (const row of a.slice(2)) {
    const f = SUMMARY_ROWS[String(row[0] ?? '').trim().toLowerCase()];
    if (!f) continue;
    for (const [c, k] of cols) { const v = num(row[c]); if (v != null) (months[k] ||= {})[f] = v; }
  }
  for (const k of Object.keys(months)) if (months[k].rev == null && months[k].subs == null) delete months[k];
  return Object.keys(months).length ? months : null;
}

// "LTV": month names without years. The last column is taken as the latest
// such month on or before `anchor` (the newest month in the file), counting back one month per column.
function parseLTV(ws, anchor){
  const a = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  if (a.length < 2 || !anchor) return null;
  const head = a[0].slice(1).map(h => MN.indexOf(String(h ?? '').trim().slice(0, 3)));
  while (head.length && head[head.length - 1] < 0) head.pop();
  if (!head.length || head.some(m => m < 0)) return null;
  let [ay, am] = anchor.split('-').map(Number); am -= 1;
  const lastM = head[head.length - 1]; let y = lastM <= am ? ay : ay - 1;
  const months = new Array(head.length);
  for (let i = head.length - 1, m = lastM; i >= 0; i--) { months[i] = key(y, m); if (--m < 0) { m = 11; y--; } }
  const rows = {}; let total = null;
  for (const r of a.slice(1)) {
    const name = String(r[0] ?? '').trim(); if (!name) continue;
    const vals = head.map((_, i) => num(r[i + 1]));
    if (vals.every(v => v == null)) continue;
    if (name.toLowerCase() === 'total') total = vals; else rows[name.length <= 3 ? name.toUpperCase() : name[0].toUpperCase() + name.slice(1)] = vals;
  }
  return { months, rows, total };
}

export function parseWorkbook(buf){
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const salesName = wb.SheetNames.find(n => n.startsWith('PackagesProfitability'));
  const sumName = wb.SheetNames.find(n => n.trim().toLowerCase() === 'vnumber summary');
  const ltvName = wb.SheetNames.find(n => n.trim().toLowerCase() === 'ltv');
  if (!salesName && !sumName && !ltvName) throw new Error('This file has none of the expected tabs (PackagesProfitability…, Vnumber Summary, LTV). Upload the monthly Package Profitability report.');
  const sales = salesName ? parseSales(wb.Sheets[salesName]) : null;
  const summary = sumName ? parseSummary(wb.Sheets[sumName]) : null;
  const anchor = [...Object.keys(sales || {}), ...Object.keys(summary || {})].sort().pop();
  const ltv = ltvName ? parseLTV(wb.Sheets[ltvName], anchor) : null;
  if (!(sales && Object.keys(sales).length) && !summary && !ltv) throw new Error('No data was found in the report tabs.');
  return { sales, summary, ltv };
}

// ── Firestore ──
export async function loadAll(){
  const [snap, metaSnap, sumSnap, ltvSnap] = await Promise.all([
    getDocs(collection(db, 'mkt_sales')),
    getDoc(doc(db, 'mkt_salesMeta', 'last')).catch(() => null),
    getDoc(doc(db, 'mkt_vnumber', 'summary')).catch(() => null),
    getDoc(doc(db, 'mkt_vnumber', 'ltv')).catch(() => null),
  ]);
  const sales = {};
  snap.forEach(d => { if (/^\d{4}-\d{2}$/.test(d.id)) sales[d.id] = JSON.parse(d.data().rows); });
  const m = metaSnap?.exists() ? metaSnap.data() : null;
  const s = sumSnap?.exists() ? sumSnap.data() : null;
  const l = ltvSnap?.exists() ? ltvSnap.data() : null;
  return {
    sales, meta: m ? { by: m.by, at: m.at?.toDate?.() } : null,
    summary: s ? JSON.parse(s.months) : null,
    ltv: l ? { months: JSON.parse(l.months), rows: JSON.parse(l.rows), total: l.total ? JSON.parse(l.total) : null } : null,
  };
}

async function save(parsed, fileName){
  const by = auth.currentUser?.displayName || auth.currentUser?.email || '';
  const keys = Object.keys(parsed.sales || {}).sort();
  for (let i = 0; i < keys.length; i += 400) {
    const b = writeBatch(db);
    keys.slice(i, i + 400).forEach(k => b.set(doc(db, 'mkt_sales', k), { month: k, rows: JSON.stringify(parsed.sales[k]), rowCount: parsed.sales[k].length, source: fileName, uploadedBy: by, uploadedAt: serverTimestamp() }));
    await b.commit();
  }
  if (parsed.summary) await setDoc(doc(db, 'mkt_vnumber', 'summary'), { months: JSON.stringify(parsed.summary), source: fileName, uploadedBy: by, uploadedAt: serverTimestamp() });
  if (parsed.ltv) await setDoc(doc(db, 'mkt_vnumber', 'ltv'), { months: JSON.stringify(parsed.ltv.months), rows: JSON.stringify(parsed.ltv.rows), total: JSON.stringify(parsed.ltv.total), source: fileName, uploadedBy: by, uploadedAt: serverTimestamp() });
  await setDoc(doc(db, 'mkt_salesMeta', 'last'), { by, at: serverTimestamp(), file: fileName, from: keys[0] || null, to: keys[keys.length - 1] || null, summary: !!parsed.summary, ltv: !!parsed.ltv });
}

function describe(p){
  const parts = [], keys = Object.keys(p.sales || {}).sort();
  if (keys.length) parts.push(keys.length === 1 ? `sales for ${monthName(keys[0])}` : `sales for ${keys.length} months (${monthName(keys[0])} to ${monthName(keys[keys.length - 1])})`);
  if (p.summary) parts.push('the Vnumber summary');
  if (p.ltv) parts.push('LTV by country');
  return parts.join(', ');
}

// ── Page shell: auth gate, sign-out, upload button ──
// opts.render(data) draws the page; opts.ready(data) says whether there is enough to draw.
export function initPage(opts){
  const gate = html => { $('app').hidden = true; const g = $('gate'); g.hidden = false; g.innerHTML = html; };
  const show = data => {
    if (!opts.ready(data)) { gate(`<h1>${opts.title}</h1><p>${opts.emptyText}</p><button class="btn primary" type="button" id="upload2">Upload monthly report</button>`); $('upload2').onclick = () => $('file').click(); return; }
    $('gate').hidden = true; $('app').hidden = false;
    const n = $('srcnote'), m = data.meta;
    if (n) n.textContent = m ? `Last upload ${m.at ? m.at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}${m.by ? ' by ' + m.by : ''}` : '';
    opts.render(data);
  };
  let current = null;
  async function upload(file){
    const btn = $('upload'); btn.disabled = true; btn.textContent = 'Reading…';
    try {
      const p = parseWorkbook(await file.arrayBuffer());
      if (LOCAL_PREVIEW) {
        current = { ...current, meta: null, sales: { ...(current?.sales || {}), ...(p.sales || {}) }, summary: p.summary || current?.summary, ltv: p.ltv || current?.ltv };
        toast(`Read ${describe(p)} (local preview — not saved)`); show(current); return;
      }
      btn.textContent = 'Saving…';
      await save(p, file.name);
      toast(`Saved ${describe(p)}. Reloading…`);
      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      console.error(e);
      toast(/permission|insufficient/i.test(e.message || '') ? 'Firestore refused the save. The security rules need to allow the mkt_sales, mkt_salesMeta and mkt_vnumber collections.' : e.message);
    } finally { btn.disabled = false; btn.textContent = 'Upload monthly report'; }
  }
  $('upload').onclick = () => $('file').click();
  $('file').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) upload(f); };
  $('signout').onclick = async () => { if (LOCAL_PREVIEW) { location.search = ''; return; } await signOut(auth); location.href = 'index.html'; };

  if (LOCAL_PREVIEW) {
    $('user-display').textContent = 'Local preview';
    fetch('test-report.xlsx').then(r => r.ok ? r.arrayBuffer() : null)
      .then(b => { const p = b ? parseWorkbook(b) : {}; current = { sales: p.sales || {}, summary: p.summary || null, ltv: p.ltv || null, meta: null }; show(current); })
      .catch(e => { console.error(e); current = { sales: {}, summary: null, ltv: null, meta: null }; show(current); });
    return;
  }
  onAuthStateChanged(auth, async user => {
    if (!user || !allowedEmail(user.email)) { gate(`<h1>Sign in to continue</h1><p>${opts.title} figures are for 011 Global and 011 Telecom staff. Sign in on the marketing dashboard, then come back here.</p><a class="btn primary" href="index.html">Go to sign in</a>`); return; }
    $('user-display').textContent = user.displayName || user.email;
    gate('<p>Loading…</p>');
    try { current = await loadAll(); show(current); }
    catch (e) {
      console.error(e);
      gate(`<h1>${opts.title} could not load</h1><p>${/permission|insufficient/i.test(e.message || '') ? 'Firestore refused access. The security rules need to allow signed-in staff to read the mkt_sales and mkt_vnumber collections.' : 'Something went wrong while loading. Reload the page to try again.'}</p>`);
    }
  });
}

// Package rows per month → the compact {d, m, t, p, r} format the Sales page draws from.
export function toDATA(months){
  const D = Object.keys(months).sort(), M = new Set(), T = new Set(['Monthly','Prepaid']), P = new Set();
  for (const k of D) for (const r of months[k]) { M.add(r[0]); T.add(r[1]); P.add(r[2]); }
  const m = [...M].sort(), t = [...T], p = [...P].sort();
  const mi = new Map(m.map((v,i)=>[v,i])), ti = new Map(t.map((v,i)=>[v,i])), pi = new Map(p.map((v,i)=>[v,i]));
  const rows = [];
  D.forEach((k, di) => { for (const r of months[k]) rows.push([di, mi.get(r[0]), ti.get(r[1]), pi.get(r[2]), r[3], r[4], r[5], r[6]]); });
  return { d: D, m, t, p, r: rows };
}
