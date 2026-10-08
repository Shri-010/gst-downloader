# GST Downloader 0.8.2

By **The CA TechiGuy**. An independent Chrome extension for downloading GST return files from your own logged-in GST portal account. Not affiliated with GSTN or the Government of India.

## Install from GitHub

1. On this repository, select **Code > Download ZIP** and extract it to a permanent folder.
2. Open `chrome://extensions` in desktop Chrome (version 120 or later).
3. Enable **Developer mode**.
4. Select **Load unpacked**, then choose the extracted folder containing `manifest.json`.
5. Open the official GST portal and log in yourself. Open GST Downloader from Chrome's Extensions menu.

This GitHub version is installed manually and does not update automatically. Download a newer version into your extension folder and select **Reload** on `chrome://extensions` to update it. Managed browsers may restrict developer-mode installations.

Do not upload GST returns, GSTINs, credentials, tokens, or unredacted screenshots when reporting an issue. Describe the selected return, period, and error using redacted examples.

## Update and use

Copy every file in this folder into your existing extension folder, replacing matching files, and reload the extension in Chrome. Include the new batch.js file. No new permissions are required compared with version 0.7.0.

1. Stay logged in to GST and open the extension.
2. Enter From and To as MMYYYY, for example 042025 to 032026. Both endpoints are included. Use the same value for a single period.
3. Choose Every month, or Quarter-ending months only for quarterly filings. Quarter-ending selection includes March, June, September and December within the selected range; it does not extend the range. Maximum batch length is 120 calendar months.
4. Choose the return. For GSTR-1, click Request files to submit the selected months. Later, click Download files to collect them. For GSTR-2B or GSTR-3B, click Download range.
5. Keep Chrome and the GST tab open. The popup can close. Progress shows completed periods and the current period. GSTR-1 also shows whether it is requesting or downloading and the number of acknowledged requests.

## Output formats

- GSTR-1: Request files submits generation for every selected period and stops after acknowledgement. Download files separately checks those requests and downloads every available ZIP part in period order. Pending files are checked every 30 seconds, with up to 25 minutes allowed per period. ZIP files go under Downloads/GST-Downloads/<GSTIN>/<FY>. Saved acknowledgements are tied to the GSTIN and survive a browser restart. Download files requires a request recorded by this version for the same account and period; otherwise it asks you to use Request files first.
- GSTR-2B: downloads the portal's Excel details first, then JSON. A period is complete only after both downloads finish. Excel uses Chrome's normal download folder. JSON goes under Downloads/GST-Downloads/<GSTIN>/<FY>, named GSTR-2B_<period>.json (or GSTR-2BQ_<period>.json for a quarterly statement).
- GSTR-3B: downloads the portal PDF for each period into Chrome's normal download folder.

For quarterly GSTR-2B, JSON uses the same-origin getjson request observed in the page's resource history during its Excel export, retaining the portal's quarter-specific parameters. If that request cannot be identified, the extension reports that Excel was saved but JSON could not be obtained, and stops. It does not generate replacement JSON from the spreadsheet. This quarterly JSON path still needs live verification.

## Batch behavior

GSTR-1 has separate request and download actions; requesting never automatically starts downloading. Downloading checks existing acknowledged requests and accepts ready files without asking for fresh generation. GSTR-2B and GSTR-3B finish each period before starting the next. Per-period download IDs and page state are reset between periods. The batch stays bound to the first confirmed GSTIN and stops if the account changes. Previously downloaded files are preserved with Chrome's duplicate-name numbering.

If a request or download fails, the batch stops at that period; it does not silently skip it. Completed-period progress remains visible. After resolving the issue, start a new range from the failed period; already completed earlier periods do not need to be selected again. A format that already downloaded during a partial failure may be downloaded again on retry.

Stop waiting prevents further batch work; it does not cancel a request already accepted by GST or a file already downloading. Generation and batch state persist while the popup is closed and the worker sleeps, within the current browser session. Login expiry, closing the GST tab, browser restart, or extension reload can interrupt the batch.

## Validation

Version 0.8.2 passes 34 local regression tests, including request-only completion, saved account-specific acknowledgements, download-only collection, refusal to generate without a saved request, range sequencing, and previous download safeguards. JavaScript syntax checks passed. The separate-button flow has not yet been verified end to end on the live portal. Quarterly JSON request discovery also still needs live confirmation.

## Data and scope

No return filing, editing, payments, password or token collection. Access remains limited to services.gst.gov.in, return.gst.gov.in and gstr2b.gst.gov.in. Files are saved locally. Storage holds preferences, progress and file metadata, not the raw return response. Portal page structure, request routes and filename conventions may change.

