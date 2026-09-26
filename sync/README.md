# Google Ads → dashboard sync

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
5. **Project Settings → Script properties**:
   - `DEVELOPER_TOKEN`: the token from step 1
   - `LOGIN_CUSTOMER_ID`: the manager account ID, digits only
6. `CONFIG.MARKETS` already has the account IDs: Israel 243-887-6474, Brazil 122-027-9929.

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
