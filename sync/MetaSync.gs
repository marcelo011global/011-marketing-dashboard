/**
 * Meta Ads → Firestore sync for marketing.011telecom.com
 *
 * Same idea as AdsSync.gs: a Google Apps Script that runs daily, reads each
 * Meta ad account through the Marketing API and writes the collections the
 * dashboard reads (mkt_campaigns, mkt_dailyStats) with platform: 'meta'.
 * Firestore is written with the owner's Google login; Meta is read with a
 * System User token stored in Script properties (never in this file).
 *
 * Setup: see sync/README.md → "Meta". Entry points:
 *   testConnection()      check the token and account IDs
 *   backfill()            first run — last 180 days
 *   dailySync()           scheduled — last 14 days (Meta revises recent conversions)
 *   installDailyTrigger() run once
 */

// ───────────────────────── Config ─────────────────────────
var META = {
  API_VERSION: 'v26.0',
  TOKEN: PropertiesService.getScriptProperties().getProperty('META_TOKEN'),
  FIRESTORE: 'projects/telecom-deals-f155b/databases/(default)/documents',
  // One entry per Meta ad account. marketId must match a market in the dashboard
  // ('il' Israel, 'br' Brazil). accountId: the number from Ads Manager, no "act_".
  ACCOUNTS: [
    { marketId: 'il', accountId: '584900745480085' },   // 011 Global Israel
    { marketId: 'br', accountId: 'REPLACE_BRAZIL_META_ACCOUNT_ID' },   // not found yet in the 011Global portfolio
  ],
};

// Meta action types counted as leads / purchases (pixel, Conversions API and on-Meta forms).
var LEAD_ACTIONS = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead', 'onsite_web_lead'];
var PURCHASE_ACTIONS = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'onsite_web_purchase'];

// ───────────────────────── Entry points ─────────────────────────
function backfill() { syncAll_(180); }
function dailySync() { syncAll_(14); }

function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailySync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailySync').timeBased().everyDays(1).atHour(3).create();
}

// Accounts whose ID hasn't been filled in yet are skipped.
function accounts_() { return META.ACCOUNTS.filter(function (a) { return /^\d+$/.test(a.accountId); }); }

function testConnection() {
  accounts_().forEach(function (a) {
    var acc = graph_('act_' + a.accountId, { fields: 'name,currency,account_status' });
    Logger.log(a.marketId + ': ' + JSON.stringify(acc));
  });
}

// ───────────────────────── Sync ─────────────────────────
function syncAll_(days) {
  if (!META.TOKEN) throw new Error('Set META_TOKEN in Project Settings → Script properties.');
  var until = ymd_(addDays_(new Date(), -1)), since = ymd_(addDays_(new Date(), -days));
  accounts_().forEach(function (a) { syncAccount_(a, since, until); });
}

function syncAccount_(a, since, until) {
  var act = 'act_' + a.accountId;
  var account = graph_(act, { fields: 'currency' });

  var campaigns = graphAll_(act + '/campaigns', {
    fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget', limit: 200,
  });

  var insights = graphAll_(act + '/insights', {
    level: 'campaign',
    time_increment: 1,
    time_range: JSON.stringify({ since: since, until: until }),
    fields: 'campaign_id,campaign_name,date_start,impressions,clicks,spend,actions,action_values',
    limit: 500,
  });

  var writes = [];
  campaigns.forEach(function (c) {
    writes.push(upsert_('mkt_campaigns/' + a.marketId + '-meta-' + c.id, {
      marketId: a.marketId,
      platform: 'meta',
      metaId: String(c.id),
      name: c.name,
      type: objectiveLabel_(c.objective),
      status: c.effective_status === 'ACTIVE' ? 'ENABLED' : 'PAUSED',
      // Meta budgets are in the account's minor units (cents/agorot).
      dailyBudget: c.daily_budget ? (+c.daily_budget) / 100 : 0,
      currency: account.currency,
    }));
  });
  insights.forEach(function (r) {
    var leads = sumActions_(r.actions, LEAD_ACTIONS), purchases = sumActions_(r.actions, PURCHASE_ACTIONS);
    var id = a.marketId + '-meta-' + r.campaign_id;
    writes.push(upsert_('mkt_dailyStats/' + id + '_' + r.date_start, {
      campaignId: id, marketId: a.marketId, platform: 'meta', date: r.date_start,
      impressions: +r.impressions || 0,
      clicks: +r.clicks || 0,
      cost: +r.spend || 0,
      leads: leads, purchases: purchases, conversions: leads + purchases,
      value: sumActions_(r.action_values, PURCHASE_ACTIONS),
    }));
  });
  commit_(writes);
  Logger.log(a.marketId + ' (Meta): ' + campaigns.length + ' campaigns, ' + insights.length + ' campaign-days');
}

// Meta reports the same conversion under several action types; take the first present per group.
function sumActions_(list, types) {
  if (!list) return 0;
  for (var i = 0; i < types.length; i++) {
    var hit = list.filter(function (x) { return x.action_type === types[i]; })[0];
    if (hit) return +hit.value || 0;
  }
  return 0;
}

function objectiveLabel_(o) {
  return { OUTCOME_LEADS: 'Leads', OUTCOME_SALES: 'Sales', OUTCOME_TRAFFIC: 'Traffic', OUTCOME_AWARENESS: 'Awareness',
           OUTCOME_ENGAGEMENT: 'Engagement', OUTCOME_APP_PROMOTION: 'App' }[o] || o;
}

// ───────────────────────── Meta Graph API ─────────────────────────
function graph_(path, params) {
  var q = Object.keys(params || {}).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  var url = 'https://graph.facebook.com/' + META.API_VERSION + '/' + path + (q ? '?' + q : '');
  return fetchJson_(url);
}
function graphAll_(path, params) {
  var out = [], page = graph_(path, params);
  while (page) {
    (page.data || []).forEach(function (x) { out.push(x); });
    page = page.paging && page.paging.next ? fetchJson_(page.paging.next) : null;
  }
  return out;
}
function fetchJson_(url) {
  var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + META.TOKEN }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Meta API ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 1500));
  return JSON.parse(resp.getContentText());
}

// ───────────────────────── Firestore (same as AdsSync.gs) ─────────────────────────
function upsert_(path, obj) { return { update: { name: META.FIRESTORE + '/' + path, fields: toFields_(obj) } }; }
function commit_(writes) {
  var url = 'https://firestore.googleapis.com/v1/' + META.FIRESTORE + ':commit';
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

// ───────────────────────── Dates ─────────────────────────
function addDays_(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
function ymd_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
