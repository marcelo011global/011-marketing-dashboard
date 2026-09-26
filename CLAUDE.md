# 011 Global — Marketing

## Project Overview
Marketing dashboard for **011 Global**'s Google Ads campaigns, which target
diaspora calling corridors (e.g. Brazilians in USA, Israelis in USA). Three sections:

1. **Performance** — campaigns and conversions grouped by **market**
   (a market = one diaspora corridor, origin → host country). Overview of all
   markets plus a detail page per market (daily spend/conversions, conversions
   by action, campaign table, pending proposals).
2. **Campaigns** — spend, clicks and conversions charts for all campaigns, or
   filtered by market / one campaign / several ticked campaigns combined.
3. **Reviews** — proposals made by the daily rule checks and the weekly agent
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
- **Backend (planned, separate repo)**: Python on Cloud Run — Google Ads API sync,
  daily rule checks, weekly Claude review, image/video generation. Writes into
  the collections below; this site only reads them and records decisions.

## Data modes
- **Sample** — shown while `mkt_markets` is empty (or unreadable). Data is generated
  in `loadSample()` with a seeded RNG. Approve/Reject still persists, but to
  `mkt_sampleDecisions` / `mkt_sampleActivity` so it can never mix with real data.
- **Live** — as soon as `mkt_markets` has documents. The top-bar pill switches from
  "Sample data" to "Live".

## Firestore Collections (written by the backend unless noted)
- `mkt_markets/{id}` — {name, origin, host, flags:[originEmoji, hostEmoji], cities[], language}
- `mkt_campaigns/{id}` — {marketId, name, type (Search|Performance Max|Display|YouTube), status (ENABLED|PAUSED), dailyBudget, googleAdsId}
- `mkt_dailyStats/{campaignId_date}` — {campaignId, marketId, date 'YYYY-MM-DD', impressions, clicks, cost, conversions, signups, purchases, value}
- `mkt_proposals/{id}` — {marketId, campaignId, type, level (approval|auto_limit), source, title, rationale, impact, change:{label,from,to}, keywords[], creatives[], createdAt, status (pending|approved|rejected|applied)}.
  **The site writes** `status, decidedBy, decidedByEmail, decidedAt, decisionNote` on Approve/Reject; the backend applies approved ones and sets `applied`.
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

## Setup (one time)
1. Create GitHub repo `marcelo011global/011-marketing-dashboard`, push, enable Pages (main branch, root).
2. DNS: `CNAME` record `marketing` → `marcelo011global.github.io` on the 011telecom.com DNS host (same place as the `deals` record).
3. Firebase console → Authentication → Settings → Authorized domains: add `marketing.011telecom.com`.
4. Firestore rules: allow signed-in company users to read `mkt_*`, and write
   `mkt_proposals` (decision fields only), `mkt_activity`, `mkt_sampleDecisions`, `mkt_sampleActivity`.

## Company Info
- **Company**: 011 Global · **Contact**: Marcelo Licht (marcelo@011global.com)
- **Firebase project**: telecom-deals-f155b (shared with the 011 Telecom deals dashboard)
