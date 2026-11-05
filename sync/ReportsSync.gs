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
 * Step 1 (now): run probe() and paste the log back. It prints each endpoint's
 * structure (field names, types, row counts, and the values of low-cardinality
 * fields such as market or package) without printing personal data.
 */

var REPORTS = {
  BASE: 'https://hub.011global.com/api/externalreports/',
  KEY: PropertiesService.getScriptProperties().getProperty('REPORTS_API_KEY'),
};

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
