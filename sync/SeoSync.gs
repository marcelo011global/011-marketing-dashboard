/**
 * Search Console + GA4 → Firestore sync for the SEO tab of marketing.011telecom.com
 *
 * Same pattern as ReportsSync.gs: a Google Apps Script in its own project, run with
 * the login of an account that can read the three Search Console properties and
 * the three GA4 properties (e.g. ai@011global.com). No keys are stored: the script
 * calls the Search Console API and the GA4 Data API with its own OAuth token, and
 * the dashboard reads what it writes to Firestore.
 *
 * Writes one Firestore doc per month per collection (AGGREGATED, no personal data —
 * neither API returns any):
 *   mkt_seoDaily/{YYYY-MM}    [day, site, clicks, impressions, posw]
 *   mkt_seoPages/{YYYY-MM}    [site, page, clicks, impressions, posw]       top pages per site
 *   mkt_seoQueries/{YYYY-MM}  [site, query, clicks, impressions, posw]      top queries per site
 *   mkt_seoMarkets/{YYYY-MM}  [site, country, device, clicks, impressions, posw]
 *   mkt_seoPageCountry/{YYYY-MM} [site, country, page, clicks, impressions, posw]  top PER_COUNTRY pages per country per site
 *   mkt_seoGa4/{YYYY-MM}      [day, site, channel, sessions, engaged, keyEvents]
 *   mkt_seoDailyType/{YYYY-MM} [day, site, type, clicks, impressions, posw]      Search Console per day per page type
 *   mkt_seoGa4Type/{YYYY-MM}   [day, site, type, sessions, engaged, keyEvents]   GA4 Organic Search per day per landing-page type
 *                             type = Home / Blog / Landing / Site page (pageType_, same rules as seo.js)
 *   mkt_seoAi/{YYYY-MM}       [site, source, host, page, sessions, engaged, keyEvents]
 *                             sessions from AI assistants (GA4 channel "AI Assistant" or a known AI source)
 *   mkt_seoLanding/{YYYY-MM}  [site, host, page, channel, sessions, engaged, keyEvents]  GA4 landing pages, all channels
 * posw = average position × impressions, so the page can sum and re-average positions.
 * Each doc: {month, cols: JSON header, rows: JSON rows, rowCount, source:'seo-sync', syncedAt}.
 *
 * Bing Webmaster Tools (bingSync(), run by dailySync() when Script property BING_API_KEY is set;
 * Bing returns its whole history, ~6 months, so every month it has is rewritten each run):
 *   mkt_seoBingDaily/{YYYY-MM}    [day, site, clicks, impressions]
 *   mkt_seoBingQueries/{YYYY-MM}  [site, query, clicks, impressions, posw]   posw = avg impression position × impressions
 *   mkt_seoBingPages/{YYYY-MM}    [site, page, clicks, impressions, posw]
 *
 * Weekly snapshots, one doc each ({cols, rows, rowCount, source, syncedAt}):
 *   mkt_seoAudit/latest  auditSync(): for each site's top pages (last 28 days) and new pages (first Google
 *                        impression in the last 90 days): HTTP status, noindex, title / description length,
 *                        H1 count, images without alt, word count, plus Search Console URL Inspection
 *                        (index verdict and coverage). New pages also get first impression date and totals.
 *   mkt_seoSpeed/latest  speedSync(): PageSpeed Insights for each site's top pages, mobile and desktop
 *                        (Lighthouse scores, LCP, CLS, and Chrome real-user INP / rating where Google has it).
 *                        Optional Script property PSI_API_KEY (a Google Cloud API key) raises the PSI quota.
 *
 * Entry points: listAccess() (run first: logs what the account can read),
 * backfill() (last 16 months, Search Console's limit), dailySync() (this month and last),
 * auditSync() and speedSync() (weekly), installDailyTrigger() (run once: daily ~5am, weekly Monday ~6am / ~7am).
 */

var SEO = {
  FIRESTORE: 'projects/telecom-deals-f155b/databases/(default)/documents',
  TZ: 'America/New_York',
  // Search Console property ("sc-domain:…" for domain properties, "https://www.…/" for URL-prefix ones)
  // and GA4 property id per site. Override with Script property SEO_SITES (same JSON shape) if needed.
  SITES: [
    { name: 'VNumber',    gsc: 'sc-domain:vnumber.com',   ga4: '463884649' },
    { name: '011 Global', gsc: 'sc-domain:011global.com', ga4: '254146485' },
    { name: 'GlobuSIM',   gsc: 'sc-domain:globusim.com',  ga4: '351943909' },
  ],
  TOP: 700,   // pages / queries kept per site per month: the top TOP by clicks plus the top TOP by impressions
  AI_SOURCES: 'chatgpt|openai|perplexity|gemini|bard|copilot|claude|anthropic|deepseek|grok|meta\\.ai|you\\.com|phind|mistral',
  MAX_DOC: 900000,   // Firestore docs are capped at 1 MiB; trim the smallest rows above this
  AUDIT_TOP: 40,     // top pages per site checked by auditSync()
  AUDIT_NEW: 20,     // new pages per site checked by auditSync()
  SPEED_TOP: 8,      // top pages per site tested by speedSync() (× mobile and desktop)
  PER_COUNTRY: 25,   // pages kept per country per site per month (Markets → click a country)
};
(function () {
  var o = PropertiesService.getScriptProperties().getProperty('SEO_SITES');
  if (o) SEO.SITES = JSON.parse(o);
})();

// ───────────────────────── Entry points ─────────────────────────
function backfill() { requireScopes_(); monthsBack_(15).forEach(syncMonth_); }
function dailySync() {
  requireScopes_(); monthsBack_(1).forEach(syncMonth_);
  // Bing runs after Google and never blocks it: no key set → skipped; an error is logged and the run still succeeds.
  if (PropertiesService.getScriptProperties().getProperty('BING_API_KEY')) {
    try { bingSync(); } catch (e) { Logger.log('Bing sync failed: ' + e.message); }
  }
}

function installDailyTrigger() {
  requireScopes_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['dailySync', 'auditSync', 'speedSync'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailySync').timeBased().everyDays(1).atHour(5).create();
  ScriptApp.newTrigger('auditSync').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
  ScriptApp.newTrigger('speedSync').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(7).create();
}

// Logs the Search Console properties and GA4 properties this account can read, and
// whether each configured site is among them. Run this first after setup.
function listAccess() {
  requireScopes_();
  var sc = get_('https://searchconsole.googleapis.com/webmasters/v3/sites').siteEntry || [];
  Logger.log('Search Console: ' + sc.map(function (s) { return s.siteUrl + ' (' + s.permissionLevel + ')'; }).join(', '));
  var ga = [], page = '';
  do {
    var r = get_('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200' + (page ? '&pageToken=' + page : ''));
    (r.accountSummaries || []).forEach(function (a) { (a.propertySummaries || []).forEach(function (p) { ga.push(p.property.split('/')[1] + ' ' + p.displayName); }); });
    page = r.nextPageToken;
  } while (page);
  Logger.log('GA4: ' + ga.join(', '));
  SEO.SITES.forEach(function (s) {
    var okSc = sc.some(function (x) { return x.siteUrl === s.gsc; });
    var okGa = ga.some(function (x) { return x.split(' ')[0] === String(s.ga4); });
    Logger.log(s.name + ': Search Console ' + (okSc ? 'OK' : 'MISSING ' + s.gsc) + ' · GA4 ' + (okGa ? 'OK' : 'MISSING ' + s.ga4));
  });
}

function requireScopes_() { ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL); }

// The current month and the n months before it, oldest first, as {key:'YYYY-MM', from, to}.
function monthsBack_(n) {
  var today = Utilities.formatDate(new Date(), SEO.TZ, 'yyyy-MM-dd');
  var y = +today.slice(0, 4), m = +today.slice(5, 7), out = [];
  for (var i = n; i >= 0; i--) {
    var yy = y, mm = m - i;
    while (mm < 1) { mm += 12; yy--; }
    var key = yy + '-' + ('0' + mm).slice(-2);
    var to = key + '-' + ('0' + new Date(yy, mm, 0).getDate()).slice(-2);
    out.push({ key: key, from: key + '-01', to: to > today ? today : to });
  }
  return out;
}

// ───────────────────────── Sync one month ─────────────────────────
// All sites are read first; if any call fails nothing is written for that month, so
// a doc never loses one site's rows because of a passing error.
function syncMonth_(p) {
  var out = { daily: [], pages: [], queries: [], markets: [], pageCountry: [], dailyType: [], ga4: [], ga4Type: [], ai: [], landing: [] };
  SEO.SITES.forEach(function (s) {
    var gq = function (dims) { return gsc_(s.gsc, { startDate: p.from, endDate: p.to, dimensions: dims, type: 'web', dataState: 'all' }); };
    var row = function (r) { return [r.clicks || 0, r.impressions || 0, round2_((r.position || 0) * (r.impressions || 0))]; };

    gq(['date']).forEach(function (r) { out.daily.push([r.keys[0], s.name].concat(row(r))); });
    top_(gq(['page'])).forEach(function (r) { out.pages.push([s.name, r.keys[0]].concat(row(r))); });
    top_(gq(['query'])).forEach(function (r) { out.queries.push([s.name, r.keys[0]].concat(row(r))); });
    gq(['country', 'device']).forEach(function (r) { out.markets.push([s.name, r.keys[0], r.keys[1]].concat(row(r))); });
    var dt = {};
    gq(['date', 'page']).forEach(function (r) {
      var k = r.keys[0] + '|' + pageType_(r.keys[1]), a = dt[k] || (dt[k] = [r.keys[0], s.name, pageType_(r.keys[1]), 0, 0, 0]);
      a[3] += r.clicks || 0; a[4] += r.impressions || 0; a[5] += (r.position || 0) * (r.impressions || 0);
    });
    Object.keys(dt).forEach(function (k) { dt[k][5] = round2_(dt[k][5]); out.dailyType.push(dt[k]); });
    perGroup_(gq(['country', 'page']), SEO.PER_COUNTRY).forEach(function (r) { out.pageCountry.push([s.name, r.keys[0], r.keys[1]].concat(row(r))); });

    var metrics = [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }];
    ga4_(s.ga4, { dateRanges: [{ startDate: p.from, endDate: p.to }], dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }], metrics: metrics, limit: 100000 })
      .forEach(function (r) { var d = r.d[0]; out.ga4.push([d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8), s.name, r.d[1]].concat(r.m)); });
    var gt = {};
    ga4_(s.ga4, {
      dateRanges: [{ startDate: p.from, endDate: p.to }],
      dimensions: [{ name: 'date' }, { name: 'hostName' }, { name: 'landingPage' }], metrics: metrics, limit: 100000,
      dimensionFilter: { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Organic Search' } } },
    }).forEach(function (r) {
      var d = r.d[0], day = d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8), t = pageType_('https://' + r.d[1] + r.d[2]);
      var a = gt[day + '|' + t] || (gt[day + '|' + t] = [day, s.name, t, 0, 0, 0]);
      a[3] += r.m[0]; a[4] += r.m[1]; a[5] += r.m[2];
    });
    Object.keys(gt).forEach(function (k) { out.ga4Type.push(gt[k]); });
    ga4_(s.ga4, {
      dateRanges: [{ startDate: p.from, endDate: p.to }],
      dimensions: [{ name: 'sessionSource' }, { name: 'hostName' }, { name: 'landingPage' }],
      metrics: metrics, limit: 10000,
      dimensionFilter: { orGroup: { expressions: [
        { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'AI Assistant' } } },
        { filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'PARTIAL_REGEXP', value: SEO.AI_SOURCES, caseSensitive: false } } },
      ] } },
    }).forEach(function (r) { out.ai.push([s.name, r.d[0], r.d[1], r.d[2]].concat(r.m)); });
    ga4_(s.ga4, {
      dateRanges: [{ startDate: p.from, endDate: p.to }],
      dimensions: [{ name: 'hostName' }, { name: 'landingPage' }, { name: 'sessionDefaultChannelGroup' }],
      metrics: metrics, limit: 5000, orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    }).forEach(function (r) { out.landing.push([s.name, r.d[0], r.d[1], r.d[2]].concat(r.m)); });
  });

  var writes = [], log = [p.key];
  function put(coll, cols, rows) {
    rows = fit_(cols, rows);
    writes.push(upsert_(coll + '/' + p.key, {
      month: p.key, cols: JSON.stringify(cols), rows: JSON.stringify(rows), rowCount: rows.length,
      source: 'seo-sync', syncedAt: new Date().toISOString(),
    }));
    log.push(coll + ' ' + rows.length);
  }
  var g = ['clicks', 'impressions', 'posw'], a = ['sessions', 'engaged', 'keyEvents'];
  put('mkt_seoDaily', ['day', 'site'].concat(g), out.daily);
  put('mkt_seoPages', ['site', 'page'].concat(g), out.pages);
  put('mkt_seoQueries', ['site', 'query'].concat(g), out.queries);
  put('mkt_seoMarkets', ['site', 'country', 'device'].concat(g), out.markets);
  put('mkt_seoPageCountry', ['site', 'country', 'page'].concat(g), out.pageCountry);
  put('mkt_seoGa4', ['day', 'site', 'channel'].concat(a), out.ga4);
  put('mkt_seoDailyType', ['day', 'site', 'type'].concat(g), out.dailyType);
  put('mkt_seoGa4Type', ['day', 'site', 'type'].concat(a), out.ga4Type);
  put('mkt_seoAi', ['site', 'source', 'host', 'page'].concat(a), out.ai);
  put('mkt_seoLanding', ['site', 'host', 'page', 'channel'].concat(a), out.landing);
  commit_(writes);
  Logger.log(log.join(' · '));
}

// ───────────────────────── Weekly: page audit ─────────────────────────
function auditSync() {
  requireScopes_();
  var d = function (n) { return Utilities.formatDate(new Date(Date.now() - n * 864e5), SEO.TZ, 'yyyy-MM-dd'); };
  var rows = [];
  SEO.SITES.forEach(function (s) {
    var q = function (from, to, extra) { var b = { startDate: from, endDate: to, dimensions: ['page'], type: 'web', dataState: 'all' }; for (var k in extra) b[k] = extra[k]; return gsc_(s.gsc, b); };
    var recent = q(d(30), d(1), {}), older = {};
    q(d(480), d(91), {}).forEach(function (r) { older[r.keys[0]] = 1; });
    var clicks28 = {}; q(d(28), d(1), {}).forEach(function (r) { clicks28[r.keys[0]] = r.clicks; });
    var top = Object.keys(clicks28).sort(function (a, b) { return clicks28[b] - clicks28[a]; }).slice(0, SEO.AUDIT_TOP);
    // New pages: impressions in the last 90 days but none in the 16 months before.
    var last90 = q(d(90), d(1), {}).filter(function (r) { return !older[r.keys[0]]; })
      .sort(function (a, b) { return b.impressions - a.impressions; }).slice(0, SEO.AUDIT_NEW);
    var fresh = {};
    last90.forEach(function (r) {
      var days = gsc_(s.gsc, { startDate: d(90), endDate: d(1), dimensions: ['date'], type: 'web', dataState: 'all',
        dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: r.keys[0] }] }] });
      fresh[r.keys[0]] = { first: days.length ? days.map(function (x) { return x.keys[0]; }).sort()[0] : '', impr: r.impressions, clicks: r.clicks };
    });
    var urls = top.concat(Object.keys(fresh).filter(function (u) { return top.indexOf(u) < 0; }));
    var pages = fetchPages_(urls), insp = inspect_(s.gsc, urls);
    urls.forEach(function (u, i) {
      var p = pages[i], n = fresh[u] || {}, x = insp[i] || {};
      rows.push([s.name, u, p.status, p.location, p.noindex, p.canonical, p.titleLen, p.descLen, p.h1, p.imgNoAlt, p.words,
        x.verdict || '', x.coverageState || '', x.lastCrawlTime || '', fresh[u] ? 'Yes' : 'No', n.first || '', n.impr || 0, n.clicks || 0, clicks28[u] || 0]);
    });
  });
  putLatest_('mkt_seoAudit', ['site', 'url', 'status', 'location', 'noindex', 'canonical', 'title_len', 'desc_len', 'h1', 'img_no_alt', 'words',
    'verdict', 'coverage', 'last_crawl', 'is_new', 'first_impression', 'impr_to_date', 'clicks_to_date', 'clicks28'], rows);
}

// Fetches pages in parallel (no redirects followed) and reads the on-page basics from the HTML.
function fetchPages_(urls) {
  var out = [];
  for (var i = 0; i < urls.length; i += 20) {
    var reqs = urls.slice(i, i + 20).map(function (u) { return { url: u, followRedirects: false, muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 011GlobalSEOAudit/1.0)' } }; });
    UrlFetchApp.fetchAll(reqs).forEach(function (r) {
      var h = r.getAllHeaders(), code = r.getResponseCode(), html = code < 300 ? r.getContentText() : '';
      var head = (html.match(/<head[\s\S]*?<\/head>/i) || [''])[0];
      var meta = function (name) { var m = head.match(new RegExp('<meta[^>]+name=["\']' + name + '["\'][^>]*>', 'i')); return m ? ((m[0].match(/content=["']([^"']*)["']/i) || [])[1] || '') : null; };
      var robots = (meta('robots') || '') + ' ' + (h['X-Robots-Tag'] || h['x-robots-tag'] || '');
      var title = ((head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
      var body = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ');
      var text = body.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
      out.push({
        status: code, location: h.Location || h.location || '', noindex: /noindex/i.test(robots) ? 'Yes' : 'No',
        canonical: ((head.match(/<link[^>]+rel=["']canonical["'][^>]*>/i) || [''])[0].match(/href=["']([^"']*)["']/i) || [])[1] || '',
        titleLen: decode_(title).length, descLen: decode_(meta('description') || '').length,
        h1: (body.match(/<h1[\s>]/gi) || []).length,
        imgNoAlt: (body.match(/<img\b[^>]*>/gi) || []).filter(function (t) { return !/\balt=["'][^"']+["']/i.test(t); }).length,
        words: html ? (text.match(/[A-Za-zÀ-ÿ0-9\u0590-\u05FF]+/g) || []).length : 0,
      });
    });
  }
  return out;
}
function decode_(s) { return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }

// Search Console URL Inspection (quota 2,000 a day per property) → indexStatusResult per URL.
function inspect_(site, urls) {
  var out = [];
  for (var i = 0; i < urls.length; i += 10) {
    var reqs = urls.slice(i, i + 10).map(function (u) {
      return { url: 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, payload: JSON.stringify({ inspectionUrl: u, siteUrl: site }) };
    });
    UrlFetchApp.fetchAll(reqs).forEach(function (r) {
      if (r.getResponseCode() !== 200) { Logger.log('URL Inspection ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200)); out.push({}); return; }
      out.push(((JSON.parse(r.getContentText()).inspectionResult || {}).indexStatusResult) || {});
    });
  }
  return out;
}

// ───────────────────────── Weekly: PageSpeed Insights ─────────────────────────
function speedSync() {
  requireScopes_();
  var key = PropertiesService.getScriptProperties().getProperty('PSI_API_KEY');
  var d = function (n) { return Utilities.formatDate(new Date(Date.now() - n * 864e5), SEO.TZ, 'yyyy-MM-dd'); };
  var jobs = [];
  SEO.SITES.forEach(function (s) {
    gsc_(s.gsc, { startDate: d(28), endDate: d(1), dimensions: ['page'], type: 'web', dataState: 'all' })
      .sort(function (a, b) { return b.clicks - a.clicks; }).slice(0, SEO.SPEED_TOP)
      .forEach(function (r) { ['mobile', 'desktop'].forEach(function (st) { jobs.push({ site: s.name, url: r.keys[0], strategy: st }); }); });
  });
  var rows = [], t0 = Date.now();
  for (var i = 0; i < jobs.length && Date.now() - t0 < 270000; i += 12) {
    var batch = jobs.slice(i, i + 12);
    var resps = UrlFetchApp.fetchAll(batch.map(function (j) {
      return { url: 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=' + encodeURIComponent(j.url) + '&strategy=' + j.strategy +
        '&category=performance&category=seo&category=accessibility' + (key ? '&key=' + key : ''), muteHttpExceptions: true };
    }));
    resps.forEach(function (r, k) {
      var j = batch[k];
      if (r.getResponseCode() !== 200) { Logger.log('PSI ' + r.getResponseCode() + ' ' + j.url + ': ' + r.getContentText().slice(0, 200)); return; }
      var x = JSON.parse(r.getContentText()), lh = x.lighthouseResult || {}, c = lh.categories || {}, a = lh.audits || {}, le = x.loadingExperience || {}, fm = le.metrics || {};
      var sc = function (n) { return c[n] ? Math.round(c[n].score * 100) : ''; };
      var num = function (n) { return a[n] ? a[n].numericValue : ''; };
      var rating = { FAST: 'Fast', AVERAGE: 'Average', SLOW: 'Slow' }[le.overall_category] || '';
      rows.push([j.site, j.url, j.strategy, sc('performance'), sc('seo'), sc('accessibility'),
        round2_((num('largest-contentful-paint') || 0) / 1000), round2_(num('cumulative-layout-shift') || 0), Math.round(num('total-blocking-time') || 0),
        fm.INTERACTION_TO_NEXT_PAINT ? fm.INTERACTION_TO_NEXT_PAINT.percentile : '', rating]);
    });
  }
  if (rows.length < jobs.length) Logger.log('Tested ' + rows.length + ' of ' + jobs.length + ' (time limit or errors)');
  putLatest_('mkt_seoSpeed', ['site', 'url', 'strategy', 'performance', 'seo', 'accessibility', 'lcp_s', 'cls', 'tbt_ms', 'field_inp_ms', 'field_rating'], rows);
}

function putLatest_(coll, cols, rows) {
  commit_([upsert_(coll + '/latest', { cols: JSON.stringify(cols), rows: JSON.stringify(rows), rowCount: rows.length, source: 'seo-sync', syncedAt: new Date().toISOString() })]);
  Logger.log(coll + ' ' + rows.length);
}

// Top SEO.TOP rows by clicks plus top SEO.TOP by impressions (keeps high-impression,
// low-click queries for the striking-distance list).
function top_(rows) {
  var byC = rows.slice().sort(function (a, b) { return b.clicks - a.clicks || b.impressions - a.impressions; }).slice(0, SEO.TOP);
  var seen = {}; byC.forEach(function (r) { seen[r.keys.join('|')] = 1; });
  var byI = rows.slice().sort(function (a, b) { return b.impressions - a.impressions; }).filter(function (r) { return !seen[r.keys.join('|')]; }).slice(0, SEO.TOP);
  return byC.concat(byI);
}

// Page type from a URL — keep in step with pageType() in seo.js.
function pageType_(url) {
  var m = /^https?:\/\/([^\/?#]*)([^?#]*)/i.exec(String(url)), host = m ? m[1] : '', p = (m ? m[2] : String(url)).toLowerCase() || '/';
  if (/^\/([a-z]{2}(-[a-z]{2})?\/?)?$/.test(p)) return 'Home';
  if (/\/(blogs?|news|articles?|posts?|guides?)(\/|$)/.test(p)) return 'Blog';
  if (/\/(lp|landing|go|promo|offers?)(\/|$)/.test(p) || /^lp[.-]/i.test(host)) return 'Landing';
  return 'Site page';
}

// The top n rows (by clicks, then impressions) within each value of keys[0], e.g. top pages per country.
function perGroup_(rows, n) {
  var by = {};
  rows.forEach(function (r) { (by[r.keys[0]] = by[r.keys[0]] || []).push(r); });
  return Object.keys(by).reduce(function (out, k) {
    return out.concat(by[k].sort(function (a, b) { return b.clicks - a.clicks || b.impressions - a.impressions; }).slice(0, n));
  }, []);
}

// Keeps a doc under Firestore's size cap by dropping the rows with the fewest impressions / sessions.
function fit_(cols, rows) {
  var i = Math.max(cols.indexOf('impressions'), cols.indexOf('sessions'));
  while (rows.length && JSON.stringify(rows).length > SEO.MAX_DOC) {
    rows = rows.slice().sort(function (a, b) { return b[i] - a[i]; }).slice(0, Math.floor(rows.length * 0.9));
  }
  return rows;
}

// ───────────────────────── Google APIs ─────────────────────────
function gsc_(site, body) {
  var url = 'https://searchconsole.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(site) + '/searchAnalytics/query';
  var out = [], start = 0, rows;
  do {
    body.startRow = start; body.rowLimit = 25000;
    rows = post_(url, body).rows || [];
    out = out.concat(rows); start += rows.length;
  } while (rows.length === 25000 && start < 200000);
  return out;
}
// GA4 Data API runReport → [{d: [dimension values], m: [metric numbers]}]
function ga4_(prop, body) {
  var r = post_('https://analyticsdata.googleapis.com/v1beta/properties/' + prop + ':runReport', body);
  return (r.rows || []).map(function (x) {
    return { d: x.dimensionValues.map(function (v) { return v.value; }), m: x.metricValues.map(function (v) { return round2_(+v.value); }) };
  });
}
function post_(url, body) { return call_(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(body) }); }
function get_(url) { return call_(url, { method: 'get' }); }
function call_(url, opt) {
  opt.headers = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  opt.muteHttpExceptions = true;
  for (var attempt = 0; ; attempt++) {
    var resp = UrlFetchApp.fetch(url, opt), code = resp.getResponseCode();
    if (code === 200) return JSON.parse(resp.getContentText() || '{}');
    if ((code === 429 || code >= 500) && attempt < 3) { Utilities.sleep(2000 * (attempt + 1)); continue; }
    throw new Error(url.split('?')[0] + ' → ' + code + ': ' + resp.getContentText().slice(0, 800));
  }
}
function round2_(v) { return Math.round((+v || 0) * 100) / 100; }

// ───────────────────────── Bing Webmaster Tools ─────────────────────────
// Needs Script property BING_API_KEY (Bing Webmaster Tools → Settings → API access → API key).
// probeBing() logs which sites the key can read and the shape of each report (field names and
// one sample row, no data stored), so the Bing sync can be built on the real responses.
var BING = { BASE: 'https://ssl.bing.com/webmaster/api.svc/json/' };
function bing_(method, params) {
  var key = PropertiesService.getScriptProperties().getProperty('BING_API_KEY');
  if (!key) throw new Error('Set BING_API_KEY in Project Settings → Script properties.');
  var q = Object.keys(params || {}).map(function (k) { return k + '=' + encodeURIComponent(params[k]); });
  q.push('apikey=' + key);
  var resp = UrlFetchApp.fetch(BING.BASE + method + '?' + q.join('&'), { muteHttpExceptions: true });
  var code = resp.getResponseCode();
  if (code !== 200) throw new Error('Bing ' + method + ' → ' + code + ': ' + resp.getContentText().slice(0, 300));
  var body = JSON.parse(resp.getContentText() || '{}');
  return body.d !== undefined ? body.d : body;
}
// Site name for a Bing site URL, by matching its domain to SEO.SITES ('sc-domain:vnumber.com' ↔ https://vnumber.com/).
function bingSiteName_(url) {
  var host = String(url).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
  var hit = SEO.SITES.filter(function (s) { return String(s.gsc).replace(/^sc-domain:/, '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '').toLowerCase() === host; })[0];
  return hit ? hit.name : null;
}
// "/Date(1772668800000)/" → '2026-03-05' (Bing dates are midnight UTC).
function bingDay_(d) { var m = /\((-?\d+)/.exec(String(d)); return m ? Utilities.formatDate(new Date(+m[1]), 'UTC', 'yyyy-MM-dd') : ''; }

function bingSync() {
  var months = {};   // 'YYYY-MM' → { daily: [], queries: {}, pages: {} }
  var M = function (day) { var k = day.slice(0, 7); return months[k] = months[k] || { daily: [], queries: {}, pages: {} }; };
  var addTo = function (map, site, key, r) {
    var k = site + '\u0001' + key, a = map[k] || (map[k] = [site, key, 0, 0, 0]);
    var imp = +r.Impressions || 0, ps = +r.AvgImpressionPosition || 0;
    a[2] += +r.Clicks || 0; a[3] += imp; if (ps > 0) a[4] += ps * imp;
  };
  var sites = (bing_('GetUserSites', {}) || []).filter(function (s) { return s.IsVerified && bingSiteName_(s.Url); });
  sites.forEach(function (s) {
    var name = bingSiteName_(s.Url);
    (bing_('GetRankAndTrafficStats', { siteUrl: s.Url }) || []).forEach(function (r) {
      var day = bingDay_(r.Date); if (day) M(day).daily.push([day, name, +r.Clicks || 0, +r.Impressions || 0]);
    });
    (bing_('GetQueryStats', { siteUrl: s.Url }) || []).forEach(function (r) { var day = bingDay_(r.Date); if (day) addTo(M(day).queries, name, r.Query, r); });
    (bing_('GetPageStats', { siteUrl: s.Url }) || []).forEach(function (r) { var day = bingDay_(r.Date); if (day) addTo(M(day).pages, name, r.Query, r); });
  });
  var vals = function (map) { return Object.keys(map).map(function (k) { var a = map[k]; a[4] = round2_(a[4]); return a; }); };
  var writes = [], log = [], now = new Date().toISOString();
  Object.keys(months).sort().forEach(function (k) {
    var m = months[k], put = function (coll, cols, rows) {
      rows = fit_(cols, rows);
      writes.push(upsert_(coll + '/' + k, { month: k, cols: JSON.stringify(cols), rows: JSON.stringify(rows), rowCount: rows.length, source: 'bing', syncedAt: now }));
    };
    put('mkt_seoBingDaily', ['day', 'site', 'clicks', 'impressions'], m.daily);
    put('mkt_seoBingQueries', ['site', 'query', 'clicks', 'impressions', 'posw'], vals(m.queries));
    put('mkt_seoBingPages', ['site', 'page', 'clicks', 'impressions', 'posw'], vals(m.pages));
    log.push(k + ' ' + m.daily.length + 'd/' + Object.keys(m.queries).length + 'q/' + Object.keys(m.pages).length + 'p');
  });
  commit_(writes);
  Logger.log('Bing: ' + sites.map(function (s) { return bingSiteName_(s.Url); }).join(', ') + ' · ' + log.join(' · '));
}

function probeBing() {
  var sites = bing_('GetUserSites', {});
  Logger.log('Bing sites: ' + (sites || []).map(function (s) { return s.Url + (s.IsVerified ? '' : ' (not verified)'); }).join(', '));
  (sites || []).filter(function (s) { return s.IsVerified; }).forEach(function (s) {
    ['GetRankAndTrafficStats', 'GetQueryStats', 'GetPageStats', 'GetQueryPageStats'].forEach(function (m) {
      try {
        var r = bing_(m, { siteUrl: s.Url });
        var rows = Array.isArray(r) ? r : [];
        Logger.log(s.Url + ' · ' + m + ': ' + rows.length + ' rows; fields ' + (rows[0] ? Object.keys(rows[0]).join(', ') : '—') +
          (rows[0] ? '; sample ' + JSON.stringify(rows[0]).slice(0, 300) : ''));
      } catch (e) { Logger.log(s.Url + ' · ' + m + ': ' + e.message); }
    });
  });
}

// ───────────────────────── Firestore (same as ReportsSync.gs) ─────────────────────────
function upsert_(path, obj) { return { update: { name: SEO.FIRESTORE + '/' + path, fields: toFields_(obj) } }; }
function commit_(writes) {
  var url = 'https://firestore.googleapis.com/v1/' + SEO.FIRESTORE + ':commit';
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
