# Ad platform → dashboard syncs

One Google Apps Script project per platform, each writing the same `mkt_*`
format with a `platform` field. Keep them in **separate** Apps Script projects
(the function names overlap).

# Google Ads (`AdsSync.gs`)

`AdsSync.gs` is a Google Apps Script that pulls campaign data from the Google Ads
API once a day and writes it to Firestore, where marketing.011telecom.com reads it.
It uses your own Google login (like `DriveSync.gs` in the deals dashboard), so
there is no server and no password or refresh token to store.

As soon as the first sync writes `mkt_markets`, the dashboard switches from
"Sample data" to "Live".

## 1. Developer token (Google Ads manager account)
1. Sign in to your Google Ads **manager (MCC) account**. API access only exists in
   manager accounts; if you don't have one, create it free at
   https://ads.google.com/home/tools/manager-accounts/ and link the Israel and Brazil accounts to it.
2. **Admin → API Center**. Fill in the form and accept the terms. You get a
   developer token with *Test access* straight away.
3. On the same page, **apply for Basic access**. Use case: internal reporting and
   management dashboard for our own Google Ads accounts; no third-party access.
   Real accounts only work once Basic access is approved.

## 2. Google Cloud project
The script runs under the existing Firebase project `telecom-deals-f155b`.
1. Enable the Google Ads API:
   https://console.cloud.google.com/apis/library/googleads.googleapis.com?project=telecom-deals-f155b
2. Note the **project number** (Cloud console → project dashboard). It is probably `182881118188`.

## 3. Create the script
1. https://script.google.com → **New project**, name it "011 Global — Ads Sync".
2. Paste `AdsSync.gs` into `Code.gs`.
3. **Project Settings** → tick "Show appsscript.json manifest file", then replace
   `appsscript.json` in the editor with the one in this folder.
4. **Project Settings → Google Cloud Platform (GCP) Project → Change project** →
   enter the project number from step 2.
5. **Project Settings → Script properties**: add `DEVELOPER_TOKEN` with the token from step 1.
6. The account IDs are already in `CONFIG`: manager 011Global (MCC) 624-832-7649,
   Israel 243-887-6474, Brazil 122-027-9929.

## 4. Run it
1. Run `testConnection` and approve the permissions prompt. The log should show
   each account's name and currency.
2. Run `backfill` once (last 180 days).
3. Run `installDailyTrigger` once. After that `dailySync` runs every day around 2am
   New York time, refreshing the last 14 days.

## What it writes
- `mkt_markets/{il|br}` — name, account currency, USD rate, tracking status
  (`recording` if a purchase was recorded in the last 3 days, else `not_recording`
  with the last date seen)
- `mkt_campaigns/{market}-{campaignId}` — name, type, status, daily budget
- `mkt_dailyStats/{market}-{campaignId}_{date}` — impressions, clicks, cost,
  conversions, leads, purchases, conversion value (account currency)

Leads and purchases come from each conversion action's category in Google Ads
(Purchase vs lead categories such as Submit lead form, Contact, Phone call lead).

# Meta (`MetaSync.gs`)

Reads each Meta ad account through the Marketing API (v26.0) and writes
campaigns and daily stats with `platform: 'meta'`. Leads and purchases come from
Meta's action types (pixel, Conversions API and on-Meta lead forms). Campaigns
store their own `currency`, so a Meta account in a different currency from the
market's Google Ads account is converted correctly.

## 1. Token (Meta Business Manager)
1. business.facebook.com → **Business settings → Users → System users** → Add
   (name e.g. "Dashboard sync", role Employee).
2. **Add assets** → Ad accounts → select the Israel and Brazil ad accounts →
   permission **View performance**.
3. **Generate new token** → pick any app of the business (create a simple
   "Business" app if there is none) → permission **ads_read** → expiration
   **Never**. Copy the token; it is only shown once.
4. Note the ad account IDs (Ads Manager → account dropdown; digits only, no `act_`).

## 2. Script
1. New Apps Script project "011 Global — Meta Sync", paste `MetaSync.gs`,
   replace the manifest with `appsscript.json` (same scopes as the Google one;
   the `adwords` scope is unused here and can be removed), link the same Cloud
   project number 182881118188.
2. Script properties: `META_TOKEN` = the token.
3. `META.ACCOUNTS` has Israel (584900745480085); add Brazil when known (accounts without an ID are skipped).
4. Run `testConnection`, then `backfill`, then `installDailyTrigger` (runs ~3am).
