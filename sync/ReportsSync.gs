/**
 * Internal Reports API → Firestore sync for marketing.011telecom.com
 *
 * Same pattern as AdsSync.gs: a Google Apps Script run as ai@011global.com.
 * The Reports API key lives only in Script properties (REPORTS_API_KEY) and is
 * never sent to the browser; the dashboards read what this script writes to
 * Firestore.
 *
 * Endpoints (hub.011global.com/api/externalreports, header X-Reports-ApiKey):
 *   vnumber-enrollments     monthly    year, month
 *   packages-profitability  monthly    year, month
 *   subscribers             date range fromDate, toDate (+ package, status, agent, maxCredit)
 *   mr-daily-revenue        date range fromDate, toDate (+ market, rep)
 *   sim-activations         date range fromDate, toDate
 * Date ranges are Eastern calendar dates, inclusive, max 366 days. Responses are
 * cached 30 minutes. Bad key → 401; validation errors → HTTP 200 with success:false.
 *
 * Writes one Firestore doc per month per report, AGGREGATED — no names, phone
 * numbers, customer IDs or other personal fields are stored:
 *   mkt_sales/{YYYY-MM}   packages-profitability, same rows as the Sales page's xlsx
 *                         upload: [market, type, package, subscribers, minutes, charged, cost, didCost]
 *   mkt_vnEnroll/{YYYY-MM} VNUMBER enrollments (incl. term = months interval), counted by day × DID country × origin country ×
 *                         package × creator × status × language × promo code
 *   mkt_subs/{YYYY-MM}    new subscribers, counted by day × plan × agent × creator × status × auto top-up
 *   mkt_mr/{YYYY-MM}      mobile-recharge revenue by day × market × rep (already aggregated by the API)
 *   mkt_sims/{YYYY-MM}    SIM activations by day × plan × creator × shipping type × coupon
 * Each doc: {month, cols: JSON header, rows: JSON rows, rowCount, source:'reports-api', syncedAt}.
 *
 * Entry points: backfill() (last 12 months + this month), dailySync() (this month and last),
 * installDailyTrigger() (run once, ~4am), probe() (shape only, for checking the API).
 */

var REPORTS = {
  BASE: 'https://hub.011global.com/api/externalreports/',
  KEY: PropertiesService.getScriptProperties().getProperty('REPORTS_API_KEY'),
  FIRESTORE: 'projects/telecom-deals-f155b/databases/(default)/documents',
  TZ: 'America/New_York',   // the API's calendar dates are Eastern
};

// ───────────────────────── Entry points ─────────────────────────
function backfill() { requireScopes_(); monthsBack_(12).forEach(syncMonth_); }
function dailySync() { requireScopes_(); monthsBack_(1).forEach(syncMonth_); }

function installDailyTrigger() {
  requireScopes_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailySync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailySync').timeBased().everyDays(1).atHour(4).create();
}

function requireScopes_() { ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL); }

// The current month and the n months before it, oldest first, as {key:'YYYY-MM', y, m, from, to}.
function monthsBack_(n) {
  var now = new Date(), today = Utilities.formatDate(now, REPORTS.TZ, 'yyyy-MM-dd');
  var y = +today.slice(0, 4), m = +today.slice(5, 7), out = [];
  for (var i = n; i >= 0; i--) {
    var yy = y, mm = m - i;
    while (mm < 1) { mm += 12; yy--; }
    var key = yy + '-' + ('0' + mm).slice(-2);
    var last = new Date(yy, mm, 0).getDate();
    var to = key + '-' + ('0' + last).slice(-2);
    out.push({ key: key, y: yy, m: mm, from: key + '-01', to: to > today ? today : to });
  }
  return out;
}

// ───────────────────────── Sync one month ─────────────────────────
function syncMonth_(p) {
  if (!REPORTS.KEY) throw new Error('Set REPORTS_API_KEY in Project Settings → Script properties.');
  var writes = [], log = [p.key];
  function put(coll, cols, rows) {
    writes.push(upsert_(coll + '/' + p.key, {
      month: p.key, cols: JSON.stringify(cols), rows: JSON.stringify(rows), rowCount: rows.length,
      source: 'reports-api', syncedAt: new Date().toISOString(),
    }));
    log.push(coll + ' ' + rows.length);
  }

  // Package profitability → the Sales page's own format (Bglobal → BGlobal, Renewal* → Monthly).
  var pk = data_('packages-profitability', { year: p.y, month: p.m });
  put('mkt_sales', ['market', 'type', 'package', 'subscribers', 'minutes', 'charged', 'cost', 'didCost'], pk.map(function (r) {
    var mk = String(r.market || '').trim(); if (mk.toLowerCase() === 'bglobal') mk = 'BGlobal';
    var ty = String(r.type || '').trim(); if (ty.indexOf('Renewal') === 0) ty = 'Monthly';
    return [mk, ty, String(r.packageName || '').trim(), Math.round(+r.subscribers || 0), Math.round(+r.minutes || 0),
            round2_(r.charged), round2_(r.cost), round2_(r.dIDCost)];
  }));

  var en = data_('vnumber-enrollments', { year: p.y, month: p.m });
  put('mkt_vnEnroll',
    ['day', 'didCountry', 'originCountry', 'package', 'creator', 'status', 'language', 'promo', 'term',
     'count', 'amount', 'credit', 'closed', 'inMin', 'outMin', 'inSms', 'outSms'],
    cube_(en, function (r) {
      return [day_(r.creationDate), r.dIDCountry, r.originCountry, r.package, r.creator, r.status, r.language, r.promo_code || '', term_(r)];
    }, function (r) {
      return [1, +r.amount || 0, +r.credit || 0, r.closerDate ? 1 : 0, +r.incomingMinutes || 0, +r.outgoingMinutes || 0,
              +r.incomingSms || 0, +r.outgoingSms || 0];
    }));

  var su = data_('subscribers', { fromDate: p.from, toDate: p.to });
  put('mkt_subs', ['day', 'plan', 'agent', 'creator', 'status', 'autoTopup', 'count', 'credit'],
    cube_(su, function (r) {
      return [day_(r.creationDate), r.packageName, r.agent, r.creatorAdminUser, r.status, r.autoTopup];
    }, function (r) { return [1, +r.credit || 0]; }));

  var mr = data_('mr-daily-revenue', { fromDate: p.from, toDate: p.to });
  put('mkt_mr', ['day', 'market', 'rep', 'amount', 'transactions'],
    cube_(mr, function (r) { return [day_(r.day), r.market, r.rep]; },
             function (r) { return [+r.amount || 0, +r.numberOfTransactions || 0]; }));

  var si = data_('sim-activations', { fromDate: p.from, toDate: p.to });
  put('mkt_sims', ['day', 'plan', 'creator', 'shipping', 'coupon', 'sims', 'amount', 'couponAmount', 'shippingAmount', 'days'],
    cube_(si, function (r) { return [day_(r.orderDate), r.planName, r.creator, r.shippingType, r.coupon || '']; },
             function (r) { return [+r.simCount || 0, +r.totalAmount || 0, +r.couponAmount || 0, +r.shippingAmount || 0, +r.totalDays || 0]; }));

  commit_(writes);
  Logger.log(log.join(' · '));
}

// Groups rows by the dimension tuple and sums the measures; returns [...dims, ...measures] rows.
// Months bought up front on a VNUMBER enrollment (the report's "months interval" column): 1, 3, 12… ('' if absent).
var TERM_KEY_RE = /month.*interval|interval.*month/i;
function term_(r) {
  var k = Object.keys(r).filter(function (f) { return TERM_KEY_RE.test(f); })[0];
  var n = k ? parseInt(r[k], 10) : NaN;
  return n > 0 ? n : '';
}

function cube_(rows, dims, measures) {
  var map = {}, order = [];
  rows.forEach(function (r) {
    var d = dims(r).map(function (v) { return v === null || v === undefined ? '' : String(v).trim(); });
    var k = JSON.stringify(d), m = measures(r);
    if (!map[k]) { map[k] = d.concat(m.map(function () { return 0; })); order.push(k); }
    var row = map[k];
    m.forEach(function (v, i) { row[d.length + i] += v; });
  });
  return order.map(function (k) {
    return map[k].map(function (v) { return typeof v === 'number' ? round2_(v) : v; });
  });
}

function data_(endpoint, params) {
  var body = fetch_(endpoint, params);
  if (!body || body.isSuccessful === false || body.isError) {
    throw new Error(endpoint + ' ' + JSON.stringify(params) + ': ' + (body && (body.errorMessage || JSON.stringify(body.messages))));
  }
  return (body.result && body.result.data) || [];
}

function day_(s) { return s ? String(s).slice(0, 10) : ''; }
function round2_(v) { return Math.round((+v || 0) * 100) / 100; }

// ───────────────────────── Firestore (same as AdsSync.gs) ─────────────────────────
function upsert_(path, obj) { return { update: { name: REPORTS.FIRESTORE + '/' + path, fields: toFields_(obj) } }; }
function commit_(writes) {
  var url = 'https://firestore.googleapis.com/v1/' + REPORTS.FIRESTORE + ':commit';
  for (var i = 0; i < writes.length; i += 400) {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ writes: writes.slice(i, i + 400) }), muteHttpExceptions: true,
    });
    if (resp.getResponseCode() !== 200) throw new Error('Firestore ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 1500));
  }
}
function toValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue_) } };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'object') return { mapValue: { fields: toFields_(v) } };
  return { stringValue: String(v) };
}
function toFields_(obj) { var f = {}; Object.keys(obj).forEach(function (k) { f[k] = toValue_(obj[k]); }); return f; }

// ───────────────────────── Probe (shape only) ─────────────────────────

// Fields whose values are never logged (personal or account data)…
var PRIVATE_RE = /name|phone|mobile|email|mail|address|msisdn|number|did|iccid|imsi|imei|card|account|customer|subscriber|user|login|ip|zip|city|street|dob|birth|ssn|passport/i;
// …except staff and plan fields, which the dashboards break down by (agent/creator, rep, plan/package).
var BREAKDOWN_RE = /agent|creat|rep\b|^rep|seller|sales|plan|package|market|status|type|country/i;
var PRIVATE_FIELD = { test: function (f) { return PRIVATE_RE.test(f) && !BREAKDOWN_RE.test(f); } };

function probe() {
  if (!REPORTS.KEY) throw new Error('Set REPORTS_API_KEY in Project Settings → Script properties.');
  var calls = [
    ['vnumber-enrollments',    { year: 2026, month: 10 }],
    ['packages-profitability', { year: 2026, month: 10 }],
    ['subscribers',            { fromDate: '2026-10-01', toDate: '2026-10-31' }],
    ['mr-daily-revenue',       { fromDate: '2026-10-01', toDate: '2026-10-31' }],
    ['sim-activations',        { fromDate: '2026-10-01', toDate: '2026-10-31' }],
  ];
  calls.forEach(function (c) {
    try { describe_(c[0], fetch_(c[0], c[1])); }
    catch (e) { Logger.log('### ' + c[0] + '\nERROR ' + e.message); }
  });
}

function fetch_(endpoint, params) {
  var q = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  var resp = UrlFetchApp.fetch(REPORTS.BASE + endpoint + '?' + q, {
    headers: { 'X-Reports-ApiKey': REPORTS.KEY }, muteHttpExceptions: true,
  });
  var code = resp.getResponseCode();
  if (code !== 200) throw new Error('HTTP ' + code + ': ' + resp.getContentText().slice(0, 300));
  return JSON.parse(resp.getContentText());
}

// Logs shape only: top-level keys, the row array's length, and per field its type,
// how often it is filled, numeric totals, and the distinct values of non-private
// text fields with at most 25 distinct values.
function describe_(endpoint, body) {
  var out = ['### ' + endpoint];
  var top = body && typeof body === 'object' && !Array.isArray(body) ? body : { _array: body };
  out.push('top-level: ' + Object.keys(top).map(function (k) { return k + ':' + kind_(top[k]); }).join(', '));
  if (top.success === false) out.push('success:false → ' + JSON.stringify(top.errors || top.message || top.messages || '').slice(0, 300));
  var rows = findRows_(top);
  if (!rows) { out.push('no row array found'); Logger.log(out.join('\n')); return; }
  out.push('rows: ' + rows.path + ' (' + rows.list.length + ')');
  var stats = {};
  rows.list.forEach(function (r) {
    flatten_(r, '').forEach(function (kv) {
      var s = stats[kv[0]] || (stats[kv[0]] = { types: {}, filled: 0, sum: 0, nums: 0, vals: {} });
      var t = kind_(kv[1]); s.types[t] = true;
      if (kv[1] !== null && kv[1] !== '') s.filled++;
      if (t === 'number') { s.sum += kv[1]; s.nums++; }
      if (t === 'string' && !PRIVATE_FIELD.test(kv[0])) s.vals[kv[1]] = (s.vals[kv[1]] || 0) + 1;
    });
  });
  Object.keys(stats).forEach(function (f) {
    var s = stats[f], line = '  ' + f + ' [' + Object.keys(s.types).join('|') + '] filled ' + s.filled + '/' + rows.list.length;
    if (s.nums) line += ' sum ' + Math.round(s.sum * 100) / 100;
    var distinct = Object.keys(s.vals);
    if (PRIVATE_FIELD.test(f)) line += ' (private, values hidden)';
    else if (distinct.length && distinct.length <= (BREAKDOWN_RE.test(f) ? 80 : 25)) line += ' values: ' + distinct.map(function (v) { return v + '×' + s.vals[v]; }).join('; ');
    else if (distinct.length) line += ' ' + distinct.length + ' distinct, e.g. ' + looksLike_(distinct[0]);
    out.push(line);
  });
  Logger.log(out.join('\n'));
}

function findRows_(o) {
  if (Array.isArray(o._array)) return { path: '(root)', list: o._array };
  var keys = ['result', 'data', 'items', 'rows', 'records'];
  for (var i = 0; i < keys.length; i++) {
    var v = o[keys[i]];
    if (Array.isArray(v)) return { path: keys[i], list: v };
    if (v && typeof v === 'object') {
      for (var k in v) if (Array.isArray(v[k])) return { path: keys[i] + '.' + k, list: v[k] };
    }
  }
  for (var k2 in o) if (Array.isArray(o[k2])) return { path: k2, list: o[k2] };
  return null;
}

function flatten_(o, prefix) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return [[prefix || '(value)', Array.isArray(o) ? '[array ' + o.length + ']' : o]];
  var out = [];
  Object.keys(o).forEach(function (k) { out = out.concat(flatten_(o[k], prefix ? prefix + '.' + k : k)); });
  return out;
}

function kind_(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }

// Describes a text value's shape without revealing it (e.g. "date 2026-10-01", "text, 12 chars").
function looksLike_(s) {
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return 'date ' + s.slice(0, 10);
  return 'text, ' + String(s).length + ' chars';
}
