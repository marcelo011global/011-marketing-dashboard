/**
 * Google Ads → Firestore sync for marketing.011telecom.com
 *
 * Runs as a Google Apps Script (same pattern as DriveSync.gs in the deals
 * dashboard): it calls the Google Ads API and Firestore with the signed-in
 * user's own Google login — no server, no stored passwords.
 *
 * Writes the collections the dashboard reads:
 *   mkt_markets     one doc per market (name, currency, tracking status)
 *   mkt_campaigns   one doc per campaign (name, type, status, daily budget)
 *   mkt_dailyStats  one doc per campaign per day (spend, clicks, conversions…)
 *
 * Setup: see sync/README.md. Entry points:
 *   backfill()   first run — last 180 days
 *   dailySync()  scheduled daily — last 14 days (Google revises recent conversions)
 */

// ───────────────────────── Config ─────────────────────────
var CONFIG = {
  API_VERSION: 'v25',
  DEVELOPER_TOKEN: PropertiesService.getScriptProperties().getProperty('DEVELOPER_TOKEN'),
  // Manager account "011Global (MCC)" 624-832-7649, which the developer token belongs to.
  LOGIN_CUSTOMER_ID: '6248327649',
  FIRESTORE: 'projects/telecom-deals-f155b/databases/(default)/documents',
  // Google Ads account per market, digits only (no dashes).
  MARKETS: [
    { id: 'il', customerId: '2438876474', name: 'Israel', flags: ['🇮🇱'],
      subtitle: 'Number porting · Israelis abroad & olim from the US/Canada', language: 'Hebrew & English' },
    { id: 'br', customerId: '1220279929', name: 'Brazil', flags: ['🇧🇷'],
      subtitle: 'Brazilians abroad · calls and numbers', language: 'Portuguese & English' },
  ],
  // USD per 1 unit of account currency, for cross-market totals on the overview.
  USD_RATES: { USD: 1, ILS: 0.27, BRL: 0.18, EUR: 1.08 },
  // A market counts as "recording" if a purchase was recorded within this many days.
  RECORDING_WINDOW_DAYS: 3,
};

// Conversion action categories counted as leads; PURCHASE counts as purchases.
var LEAD_CATEGORIES = ['SUBMIT_LEAD_FORM', 'CONTACT', 'PHONE_CALL_LEAD', 'IMPORTED_LEAD', 'QUALIFIED_LEAD',
  'CONVERTED_LEAD', 'REQUEST_QUOTE', 'BOOK_APPOINTMENT', 'SIGNUP'];

// ───────────────────────── Entry points ─────────────────────────
function backfill() { syncAll_(180); }
function dailySync() { syncAll_(14); }

/** Run once: schedules dailySync every day around 2am (script time zone). */
function installDailyTrigger() {
  requireScopes_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailySync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailySync').timeBased().everyDays(1).atHour(2).create();
}

/** Quick check that the token and account IDs work, without writing anything. */
function testConnection() {
  requireScopes_();
  CONFIG.MARKETS.forEach(function (m) {
    var rows = gaql_(m.customerId, 'SELECT customer.descriptive_name, customer.currency_code FROM customer');
    Logger.log(m.id + ': ' + JSON.stringify(rows[0] && rows[0].customer));
  });
}

// ───────────────────────── Sync ─────────────────────────
// Google shows each permission as its own checkbox; if one was left unticked,
// Apps Script won't ask again unless the script requires it. This re-prompts.
function requireScopes_() { ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL); }

function syncAll_(days) {
  requireScopes_();
  if (!CONFIG.DEVELOPER_TOKEN || !CONFIG.LOGIN_CUSTOMER_ID) throw new Error('Set DEVELOPER_TOKEN in Project Settings → Script properties.');
  var end = ymd_(addDays_(new Date(), -1));
  var start = ymd_(addDays_(new Date(), -days));
  CONFIG.MARKETS.forEach(function (m) { syncMarket_(m, start, end); });
}

function syncMarket_(m, start, end) {
  var cid = m.customerId;
  var customer = gaql_(cid, 'SELECT customer.currency_code FROM customer')[0].customer;
  var currency = customer.currencyCode;

  // Campaigns (current state).
  var camps = gaql_(cid,
    "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros " +
    "FROM campaign WHERE campaign.status != 'REMOVED'");

  // Daily performance per campaign.
  var perf = gaql_(cid,
    "SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, " +
    "metrics.conversions, metrics.conversions_value FROM campaign " +
    "WHERE segments.date BETWEEN '" + start + "' AND '" + end + "' AND campaign.status != 'REMOVED'");

  // Conversions split by action category (leads vs purchases).
  var byAction = gaql_(cid,
    "SELECT campaign.id, segments.date, segments.conversion_action_category, metrics.conversions " +
    "FROM campaign WHERE segments.date BETWEEN '" + start + "' AND '" + end + "' AND metrics.conversions > 0");

  var split = {};
  byAction.forEach(function (r) {
    var key = r.campaign.id + '_' + r.segments.date;
    var s = split[key] || (split[key] = { leads: 0, purchases: 0 });
    var n = +r.metrics.conversions || 0;
    if (r.segments.conversionActionCategory === 'PURCHASE') s.purchases += n;
    else if (LEAD_CATEGORIES.indexOf(r.segments.conversionActionCategory) >= 0) s.leads += n;
  });

  var writes = [];
  camps.forEach(function (r) {
    writes.push(upsert_('mkt_campaigns/' + m.id + '-' + r.campaign.id, {
      marketId: m.id,
      platform: 'google',
      googleAdsId: String(r.campaign.id),
      name: r.campaign.name,
      type: channelLabel_(r.campaign.advertisingChannelType),
      status: r.campaign.status,                           // ENABLED | PAUSED
      dailyBudget: r.campaignBudget ? (+r.campaignBudget.amountMicros || 0) / 1e6 : 0,
    }));
  });
  perf.forEach(function (r) {
    var campaignId = m.id + '-' + r.campaign.id, s = split[r.campaign.id + '_' + r.segments.date] || { leads: 0, purchases: 0 };
    writes.push(upsert_('mkt_dailyStats/' + campaignId + '_' + r.segments.date, {
      campaignId: campaignId, marketId: m.id, platform: 'google', date: r.segments.date,
      impressions: +r.metrics.impressions || 0,
      clicks: +r.metrics.clicks || 0,
      cost: (+r.metrics.costMicros || 0) / 1e6,
      conversions: +r.metrics.conversions || 0,
      leads: s.leads, purchases: s.purchases,
      value: +r.metrics.conversionsValue || 0,
    }));
  });
  writes.push(upsert_('mkt_markets/' + m.id, {
    name: m.name, subtitle: m.subtitle, flags: m.flags, language: m.language,
    currency: currency, usdRate: CONFIG.USD_RATES[currency] || 1,
    tracking: trackingStatus_(cid),
    syncedAt: new Date().toISOString(),
  }));
  commit_(writes);
  Logger.log(m.id + ': ' + camps.length + ' campaigns, ' + perf.length + ' campaign-days (' + start + ' → ' + end + ')');
}

/** Last day with a recorded purchase in the past year → recording / not_recording. */
function trackingStatus_(cid) {
  var rows = gaql_(cid,
    "SELECT segments.date, metrics.conversions FROM campaign " +
    "WHERE segments.date BETWEEN '" + ymd_(addDays_(new Date(), -365)) + "' AND '" + ymd_(new Date()) + "' " +
    "AND segments.conversion_action_category = 'PURCHASE' AND metrics.conversions > 0");
  var last = rows.reduce(function (acc, r) { return r.segments.date > acc ? r.segments.date : acc; }, '');
  var recent = last && last >= ymd_(addDays_(new Date(), -CONFIG.RECORDING_WINDOW_DAYS));
  return {
    status: recent ? 'recording' : 'not_recording',
    lastConversion: last || null,
    note: recent ? '' : (last ? 'No purchases recorded since ' + last + '.' : 'No purchases recorded in the last 12 months.'),
  };
}

// ───────────────────────── Google Ads API ─────────────────────────
function gaql_(customerId, query) {
  var url = 'https://googleads.googleapis.com/' + CONFIG.API_VERSION + '/customers/' + customerId + '/googleAds:searchStream';
  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'developer-token': CONFIG.DEVELOPER_TOKEN,
      'login-customer-id': CONFIG.LOGIN_CUSTOMER_ID,
    },
    payload: JSON.stringify({ query: query }),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) throw new Error('Google Ads API ' + resp.getResponseCode() + ' for ' + customerId + ': ' + resp.getContentText().slice(0, 1500));
  var out = [];
  JSON.parse(resp.getContentText()).forEach(function (batch) { (batch.results || []).forEach(function (r) { out.push(r); }); });
  return out;
}

function channelLabel_(t) {
  return { SEARCH: 'Search', PERFORMANCE_MAX: 'Performance Max', DISPLAY: 'Display', VIDEO: 'YouTube',
           DEMAND_GEN: 'Demand Gen', SHOPPING: 'Shopping', MULTI_CHANNEL: 'App' }[t] || t;
}

// ───────────────────────── Firestore ─────────────────────────
function upsert_(path, obj) {
  return { update: { name: CONFIG.FIRESTORE + '/' + path, fields: toFields_(obj) } };
}

function commit_(writes) {
  var url = 'https://firestore.googleapis.com/v1/' + CONFIG.FIRESTORE + ':commit';
  for (var i = 0; i < writes.length; i += 400) {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ writes: writes.slice(i, i + 400) }),
      muteHttpExceptions: true,
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
function toFields_(obj) {
  var f = {};
  Object.keys(obj).forEach(function (k) { f[k] = toValue_(obj[k]); });
  return f;
}

// ───────────────────────── Dates ─────────────────────────
function addDays_(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
function ymd_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
