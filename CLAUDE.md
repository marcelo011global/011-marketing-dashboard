# 011 Global — Marketing

## Project Overview
Marketing dashboard for **011 Global**'s Google Ads campaigns, which target
Israel and Brazil markets. Four sections, plus a Sales page (below):

1. **Performance** — campaigns and conversions grouped by **market**. Two markets:
   **Israel** (number porting, per the strategy doc — Israelis abroad and US/Canadian
   olim, 7 campaigns + legacy Performance Max, account in ILS) and **Brazil**
   (placeholder campaigns until it has a strategy, USD), plus **VNUMBER**
   (separate brand, Google Ads 999-677-4190, USD). Markets carry a `brand`
   ('011global' default | 'vnumber'); the top-bar brand filter scopes every view. Overview of all
   markets plus a detail page per market (daily spend/conversions, conversions
   by action, campaign table, pending proposals).
2. **Campaigns** — spend, clicks and conversions charts for all campaigns, or
   filtered by market / one campaign / several ticked campaigns combined.
3. **Landing pages** — the shared list of where each campaign sends traffic
   (URL, market, language, campaigns/audience, main conversion path, headline,
   status, notes). Real data, editable by the team; one click adds the 8 pages
   from the Israel strategy. New ads and suggestions should point at pages here.
4. **Reviews** — proposals made by the daily rule checks and the weekly agent
   review (budget changes, pauses, keywords, bid strategy, new creatives), with
   Approve/Reject, decision history, weekly review summaries and an activity log.

Sibling of [011-deals-dashboard](https://github.com/marcelo011global/011-deals-dashboard)
(deals.011telecom.com, 011 Telecom) and teligen-crm: same build philosophy (single HTML
file, vanilla JS, Firebase, GitHub Pages). Branded 011 Global: `logo.png` (trimmed from the official logo), `favicon.png` (the orange "011" speech bubble), brand orange `#EE7805` sampled from the logo.

## Live URL
- Production: https://marketing.011telecom.com (GitHub Pages — see Setup below)
- Local: serve the folder and open `http://localhost:<port>/?preview` — skips
  sign-in and runs fully on sample data without touching Firestore (localhost only).

## Tech Stack
- **Frontend**: `index.html` only — vanilla JS, no framework, no build step
- **Database/Auth**: the **same Firebase project as the deals dashboard**
  (`telecom-deals-f155b`), so one login works on both sites. All marketing data
  lives in `mkt_*` collections.
- **Auth**: Email/Password + Google Sign-In, restricted to `@011global.com` / `@011telecom.com`.
  No sign-up form here — accounts are created on deals.011telecom.com.
- **Hosting**: GitHub Pages, custom domain in `CNAME`.
- **Google Ads sync**: `sync/AdsSync.gs`, a Google Apps Script (same pattern as
  `DriveSync.gs`) that calls the Google Ads API with the owner's login and writes
  `mkt_markets`, `mkt_campaigns`, `mkt_dailyStats` daily. Setup in `sync/README.md`.
- **Meta sync**: `sync/MetaSync.gs`, same pattern via the Meta Marketing API
  (System User token in Script properties), writes `platform: 'meta'` rows.
- **Later**: daily rule checks, weekly Claude review and image/video generation
  write `mkt_proposals` / `mkt_reviews` / `mkt_activity`; this site only reads them
  and records decisions.

## Sales and VNUMBER pages (`sales.html`, `vnumber.html`)
Two pages outside the hash router, sharing `sales.css` and `sales-data.js`
(Firebase login, workbook reader, Firestore load/save, page shell with the
**Upload monthly report** button). Linked as "Sales" and "VNUMBER" in every top bar.
- **Sales** — Package Profitability dashboard (monthly retail package sales:
  subscribers, minutes, charged, cost, gross profit by market / type / package,
  sleeping packages, Vnumber split).
- **VNUMBER** — the virtual-number business: revenue (new-customer vs recurring),
  share of company sales, subscribers, new vs churned, churn rate, marketing spend,
  CPA, first-month income per new customer, margin LTV by DID country, LTV ÷ CPA,
  payback, VNUMBER packages and a month-by-month table. Recalculates the sheet's
  formulas (recurring = revenue − monthly sales; churn = prev subs + new − subs;
  CPA = spend ÷ new subs). "Share of company sales" = VNUMBER ÷ all packages
  charged; the sheet's "% of 011 Revenue" is VNUMBER ÷ the rest of 011 (shown too).
- Data (Firestore, never in the repo):
  - `mkt_sales/{YYYY-MM}` = {month, rows (JSON of [market, type, package,
    subscribers, minutes, charged, cost]), rowCount, source, uploadedBy, uploadedAt}
  - `mkt_vnumber/summary` = {months: JSON {YYYY-MM: {rev, newSales, spend, subs, newSubs}}}
    from the "Vnumber Summary" tab (row 1 years, row 2 months, labels in column A)
  - `mkt_vnumber/ltv` = {months: JSON [YYYY-MM], rows: JSON {country: [ltv]}, total}
    from the "LTV" tab (headers are month names without years; the last column
    is taken as the newest such month on or before the newest month in the file)
  - `mkt_salesMeta/last` = {by, at, file, from, to, summary, ltv}
- Upload: each tab found in the xlsx is saved; months in the package tab replace
  those months only (a one-month file adds one month); the summary and LTV docs are
  replaced whole when their tab is present. Rules: Bglobal = BGlobal,
  RenewalCombined* count as Monthly, Vnumber = package names starting `Vnumber_`,
  sleeping = subscribers with zero minutes.
- Local preview: `sales.html?preview` / `vnumber.html?preview` read a gitignored
  `test-report.xlsx` placed next to them; uploads stay in memory.
- **Download PDF** (`report-pdf.js`, both pages): captures `#app` section by
  section exactly as filtered on screen (html2canvas + jsPDF, loaded on first
  click), at a fixed 1400px layout (`body.pdf` rules in `sales.css`), onto A4
  landscape pages with a header/footer; long tables continue across pages.
- Planned: a sales API sync (like `sync/AdsSync.gs`) writing the same collections.

## Platforms
Every campaign has `platform` ('google' | 'meta'; missing = 'google'). A top-bar
filter (All / Google Ads / Meta, remembered per browser) applies to every page;
market pages show a "By platform" comparison and overview cards the spend split.
Adding a platform = a new sync writing the same format + an entry in `PLATFORMS`.

## Currency
Each market's pages show its account currency. Anything mixing markets (overview
totals, Campaigns page across markets) is converted to USD with `usdRate`
(`curOf()`, `aggFor(ids, period, cur)`).

## Data modes
- **Sample** — shown while `mkt_markets` is empty (or unreadable). Data is generated
  in `loadSample()` with a seeded RNG. Approve/Reject still persists, but to
  `mkt_sampleDecisions` / `mkt_sampleActivity` so it can never mix with real data.
- **Live** — as soon as `mkt_markets` has documents. The top-bar pill switches from
  "Sample data" to "Live".

## Firestore Collections (written by the backend unless noted)
- `mkt_markets/{id}` — {name, brand ('011global'|'vnumber', missing = 011 Global), subtitle, flags:[emoji], language, currency ('ILS'|'USD'…, the Google Ads account currency), usdRate (USD per 1 unit, for cross-market totals), tracking:{status ('recording'|'not_recording'|'check'), lastConversion 'YYYY-MM-DD', note}}
- `mkt_campaigns/{id}` — {marketId, platform ('google'|'meta'), name, type, status (ENABLED|PAUSED), dailyBudget, currency? (overrides the market's), googleAdsId | metaId}
- `mkt_dailyStats/{campaignId_date}` — {campaignId, marketId, platform, date 'YYYY-MM-DD', impressions, clicks, cost, conversions, leads (callback form), purchases, value} — cost/value in the market's currency
- `mkt_proposals/{id}` — {marketId, campaignId, type, level (approval|auto_limit), source, title, rationale, impact, change:{label,from,to}, keywords[], creatives[], createdAt, status (pending|approved|rejected|applied)}.
  **The site writes** `status, decidedBy, decidedByEmail, decidedAt, decisionNote` on Approve/Reject; the backend applies approved ones and sets `applied`.
- `mkt_landingPages/{id}` — **written by the site** (real data in every mode): {url, marketId, lang, status (live|draft|planned|retired), path (Callback form|Buy online|Phone call|WhatsApp), usedFor, headline, notes, updatedBy, createdAt, updatedAt}
- `mkt_reviews/{id}` — weekly agent review: {weekOf 'YYYY-MM-DD', author, summary, highlights[], concerns[]}
- `mkt_activity/{id}` — {at, actor, kind, text, marketId?, proposalId?} — **the site** adds one per decision; the backend adds syncs, alerts, auto-applied changes.

Proposal types: `budget_increase, budget_decrease, pause_campaign, add_keywords,
add_negative_keywords, new_creatives, bid_strategy` (labels in `TYPE_LABEL`).
Autonomy levels: `approval` (nothing happens until approved) and `auto_limit`
(applies automatically 24h after creation unless rejected; backend enforces the
±15% cap — the UI only displays it).

## Deployment
```bash
git add .
git commit -m "description of change"
git push origin main
```

## Setup (done 2026-09-26)
Repo `marcelo011global/011-marketing-dashboard` on GitHub Pages (HTTPS enforced),
GoDaddy CNAME `marketing` → `marcelo011global.github.io`, domain added to Firebase
Auth authorized domains, and existing Firestore rules already allow the `mkt_*`
writes (Approve verified on the live site).

## Company Info
- **Company**: 011 Global · **Contact**: Marcelo Licht (marcelo@011global.com)
- **Firebase project**: telecom-deals-f155b (shared with the 011 Telecom deals dashboard)

## Reports API pages (since 2026-11-05)
`sync/ReportsSync.gs` (own Apps Script project "Reports Sync" under ai@011global.com, key in Script property
REPORTS_API_KEY, manifest `sync/appsscript.reports.json`) pulls the internal Reports API
(hub.011global.com/api/externalreports) nightly at ~4am and writes AGGREGATED monthly docs — no names,
phone numbers or customer IDs: `mkt_sales` (same format as the Sales xlsx upload, plus didCost),
`mkt_vnEnroll`, `mkt_subs`, `mkt_mr`, `mkt_sims`; each doc {month, cols, rows, rowCount, source, syncedAt}.
Pages `enrollments.html`, `subscribers.html`, `recharge.html`, `sims.html` share `reports.js`
(config: coll, dims, measures, kpis). Local preview: `?preview` on localhost reads gitignored
`preview-data/<coll>.json` (synthetic only).
