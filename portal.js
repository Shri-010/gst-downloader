/* These self-contained functions are injected in the tab's ISOLATED world.
 * They use the DOM and same-origin fetch, never cookies or page JS variables. */
function statementInfo(body, info) {
  const value = body.replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\s+/g, " ");
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const fy = value.match(/Financial Year\s*[-:]\s*(20\d{2})\s*-\s*(\d{2}|20\d{2})\b/i);
  const label = value.match(/Return Period\s*[-:]\s*([A-Za-z]+)(?:\s*-\s*([A-Za-z]+))?/i);
  const gstin = value.match(/GSTIN\s*[-:]\s*([0-9]{2}[A-Z0-9]{13})\b/)?.[1];
  const monthNumber = name => months.findIndex(m => m.toLowerCase() === name?.toLowerCase() || m.slice(0,3).toLowerCase() === name?.toLowerCase()) + 1;
  const first = monthNumber(label?.[1]), last = monthNumber(label?.[2]);
  const quarterly = !!label?.[2];
  const normalizedFy = fy ? fy[1] + "-" + fy[2].slice(-2) : null;
  const expectedFirst = Math.floor((info.month - 1) / 3) * 3 + 1;
  const matches = normalizedFy === info.fy && (quarterly ? info.month % 3 === 0 && first === expectedFirst && last === info.month : first === info.month);
  return { gstin, quarterly, matches, ready: !!gstin && !!fy && first > 0 && (!quarterly || last > 0), label: label ? label[1] + (label[2] ? "-" + label[2] : "") : "unknown" };
}

async function navigatePortal(info) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const text = el => (el.textContent || "").replace(/\s+/g, " ").trim();
  const find = (selector, test) => Array.from(document.querySelectorAll(selector)).find(el => visible(el) && test(el));
  const waitFor = async test => {
    const end = Date.now() + 12000;
    while (Date.now() < end) { const result = test(); if (result) return result; await sleep(250); }
    throw new Error("The expected portal control did not appear. Open File Returns, select the year and month, click Search, and open GSTR-2B before retrying.");
  };
  const host = location.hostname;
  if (document.querySelector('input[type="password"]')) throw new Error("Your GST session needs login. Log in normally and retry.");
  if (host === "gstr2b.gst.gov.in" && info.returnType && info.returnType !== "GSTR-2B") {
    const dashboard = await waitFor(() => find("a", el => {
      try { const u = new URL(el.href); return text(el) === "Dashboard" && u.origin === "https://services.gst.gov.in" && u.pathname === "/services/auth/dashboard"; } catch { return false; }
    }));
    dashboard.click(); return { action: "navigating", message: "Opening the return dashboard" };
  }
  if (host === "gstr2b.gst.gov.in") {
    const summary = await waitFor(() => {
      const value = statementInfo(document.body.innerText, info);
      return value.ready ? value : null;
    });
    if (summary.matches) return { action: "ready", quarterly: summary.quarterly, gstin: summary.gstin };
    if (info.allowPeriodChange === false) throw new Error("The portal still shows " + summary.label + " after selecting " + info.period + ". Stopped to prevent a navigation loop.");
    const dashboard = await waitFor(() => find("a", el => {
      try { const u = new URL(el.href); return text(el) === "Dashboard" && u.origin === "https://services.gst.gov.in" && u.pathname === "/services/auth/dashboard"; } catch { return false; }
    }));
    dashboard.click();
    return { action: "navigating", message: "Changing to the requested return period automatically" };
  }
  if (host === "services.gst.gov.in") {
    const link = await waitFor(() => find("a", el => /^FILE RETURNS\b/i.test(text(el))) || find("a", el => {
      try { const u = new URL(el.href); return text(el) === "Dashboard" && u.origin === "https://services.gst.gov.in" && u.pathname === "/services/auth/dashboard" && u.href !== location.href; } catch { return false; }
    }));
    const label = /^FILE RETURNS\b/i.test(text(link)) ? "Opening File Returns" : "Opening the GST dashboard";
    link.click();
    return { action: "navigating", message: label };
  }
  if (host !== "return.gst.gov.in") throw new Error("Use a logged-in GST portal tab.");
  if (location.pathname && location.pathname !== "/returns/auth/dashboard") {
    const dashboard = await waitFor(() => find("a", el => {
      try { const u = new URL(el.href); return u.origin === "https://return.gst.gov.in" && u.pathname === "/returns/auth/dashboard" && /^Returns$/i.test(text(el)); } catch { return false; }
    }));
    dashboard.click(); return { action: "navigating", message: "Returning to the period selector" };
  }
  const selectBy = async (kind, predicate) => {
    const select = await waitFor(() => find("select", el => Array.from(el.options).some(o => kind(o.text.trim()))));
    const option = await waitFor(() => Array.from(select.options).find(o => predicate(o.text.trim()) && !o.disabled));
    if (select.value !== option.value) {
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(350);
    }
  };
  await selectBy(t => /^20\d{2}-\d{2}$/.test(t), t => t === info.fy);
  await selectBy(t => /^Quarter\s+[1-4]/i.test(t), t => new RegExp("^Quarter\\s+" + info.quarter + "\\b", "i").test(t));
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  await selectBy(t => months.includes(t), t => t === months[info.month - 1]);
  const search = await waitFor(() => find('button, input[type="button"]', el => (text(el) || el.value).toUpperCase() === "SEARCH" && !el.disabled));
  search.click();
  await sleep(1000);
  if (info.returnType && info.returnType !== "GSTR-2B") {
    await waitFor(() => returnDownloadButton(info.returnType));
    const gstin = document.body.innerText.match(/\b[0-9]{2}[A-Z0-9]{13}\b/)?.[0];
    if (!gstin) throw new Error("Cannot identify the logged-in GSTIN.");
    return { action: "return-download-ready", gstin };
  }
  const tile = await waitFor(() => find("a", el => /GSTR[\s-]?2B\b/i.test(text(el)) && /Auto\s*-?\s*drafted ITC/i.test(text(el))));
  tile.click();
  return { action: "navigating", message: "Opening GSTR-2B for the selected month" };
}

function returnDownloadButton(returnType) {
  const pattern = returnType === "GSTR-1" ? /\bGSTR\s*-?\s*1\b(?!A)/i : /\bGSTR\s*-?\s*3B\b/i;
  const visible = el => el.getClientRects().length > 0;
  const heading = Array.from(document.querySelectorAll("a")).find(el => visible(el) && pattern.test(el.textContent) && (returnType !== "GSTR-1" || /outward supplies/i.test(el.textContent)));
  if (!heading) return null;
  for (let card = heading.parentElement, level = 0; card && level < 6; card = card.parentElement, level++) {
    // Never walk into the entire dashboard and pick another return's Download.
    if (Array.from(card.querySelectorAll("a")).some(el => visible(el) && /\bGSTR\s*-?\s*(?:1A|2[AB]|3B|1)\b/i.test(el.textContent) && !pattern.test(el.textContent))) break;
    const buttons = Array.from(card.querySelectorAll("button")).filter(el => visible(el) && !el.disabled && /^DOWNLOAD$/i.test(el.textContent.trim()));
    if (buttons.length === 1) return buttons[0];
  }
  return null;
}

function clickReturnDownload(returnType, gstin) {
  if (location.origin !== "https://return.gst.gov.in" || location.pathname !== "/returns/auth/dashboard") throw new Error("Return dashboard changed before download.");
  if (!document.body.innerText.includes(gstin)) throw new Error("The GST account changed before download.");
  const button = returnDownloadButton(returnType);
  if (!button) throw new Error("The requested return's Download button is unavailable.");
  button.click(); return { clicked: true };
}

function inspectR1(info, gstin) {
  if (location.origin !== "https://return.gst.gov.in" || location.pathname !== "/returns/auth/gstr/offlinedownload") throw new Error("GSTR-1 download page changed. Retry the download.");
  const body = document.body.innerText.replace(/\s+/g, " ");
  if (!body.includes(gstin) || !/Offline Download for GSTR-1\b/i.test(body)) throw new Error("GSTR-1 page or logged-in account does not match the request.");
  const links = Array.from(document.querySelectorAll("a")).filter(el => el.getClientRects().length && /Click here to download\s*-\s*File/i.test(el.textContent)).map(el => {
    const u = new URL(el.href);
    if (u.origin !== location.origin || u.pathname !== "/returns/auth/api/offline/download/url" || u.searchParams.get("rtn_prd") !== info.period || u.searchParams.get("rtn_typ") !== "GSTR1" || !/^\d+$/.test(u.searchParams.get("file_num") || "")) throw new Error("GSTR-1 download link has a different period or unexpected address.");
    return { url: u.href, part: Number(u.searchParams.get("file_num")) };
  });
  const generating = /generation.*(?:acknowledged|in progress)|file generation is in progress/i.test(body);
  const cached = /generate the latest file.*(?:again)|downloaded the file last/i.test(body);
  return { links, generating, cached };
}

function clickR1Generate(info, gstin) {
  inspectR1(info, gstin);
  const button = Array.from(document.querySelectorAll("button")).find(el => el.getClientRects().length && !el.disabled && /^GENERATE JSON FILE TO DOWNLOAD$/i.test(el.textContent.trim()));
  if (!button) throw new Error("The GSTR-1 file-generation control is unavailable.");
  button.click();
}

async function fetchPortalReturn(info) {
  if (location.origin !== "https://gstr2b.gst.gov.in") throw new Error("Open GSTR-2B first. The API must run on the GSTR-2B host.");
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  // Verify visible account and period before issuing a data request.
  const end = Date.now() + 10000;
  let body = "";
  while (Date.now() < end) {
    body = document.body.innerText.replace(/\s+/g, " ");
    if (/Generation date\s*-/i.test(body) && /GSTIN\s*-/.test(body)) break;
    if (document.querySelector('input[type="password"]')) throw new Error("The GST session has expired. Log in normally and retry.");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const expectedGstin = body.match(/GSTIN\s*-\s*([0-9]{2}[A-Z0-9]{13})\b/)?.[1];
  if (!expectedGstin) throw new Error("The GSTR-2B summary is not ready or the session expired. Open the statement manually and retry.");
  const statement = statementInfo(body, info);
  if (!statement.matches || statement.quarterly !== !!info.quarterly) {
    throw new Error("The open GSTR-2B page is for a different period. Go to File Returns, select " + info.period + ", open GSTR-2B, and retry.");
  }
  const started = performance.now();
  try {
    let jsonUrl = "/gstr2b/auth/api/gstr2b/getjson?rtnprd=" + encodeURIComponent(info.period);
    if (statement.quarterly) {
      // The official Excel export has just run. Reuse its observed JSON route,
      // including quarter-specific parameters; never guess a quarterly API.
      const observed = performance.getEntriesByType("resource").map(entry => {
        try { return new URL(entry.name); } catch { return null; }
      }).filter(u => u && u.origin === location.origin && /^\/gstr2b\/auth\/api\//.test(u.pathname) && /\/getjson\/?$/i.test(u.pathname) && (u.searchParams.get("rtnprd") || u.searchParams.get("rtn_prd")) === info.period);
      if (!observed.length) throw new Error("Excel was saved, but the quarterly JSON request could not be identified on this portal page. No substitute JSON was created. Batch stopped at this period.");
      jsonUrl = observed[observed.length - 1].href;
    }
    const response = await fetch(jsonUrl, {
      method: "GET", credentials: "same-origin", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25000)
    });
    if (!response.ok) throw new Error("GSTR-2B request returned HTTP " + response.status + (response.status === 401 || response.status === 403 ? ". Log in again and open the statement manually." : ". Retry from the portal's GSTR-2B page."));
    if (response.redirected) throw new Error("The data request was redirected, possibly to login. Open GSTR-2B again and retry.");
    const raw = await response.text();
    // Bound extension message size; large returns should use the portal download.
    if (raw.length > 12000000) throw new Error("This return is too large for this extension. Use the portal's download button.");
    return { raw, expectedGstin, httpStatus: response.status, elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") throw new Error("The GSTR-2B request timed out after 25 seconds. Retry once the portal is responsive.");
    if (error instanceof TypeError) throw new Error("The GSTR-2B network request failed. Check the session and connection, then retry.");
    throw error;
  }
}

function downloadQuarterlyReturn(info, expectedGstin) {
  if (location.origin !== "https://gstr2b.gst.gov.in") throw new Error("The GST tab changed before download.");
  const statement = statementInfo(document.body.innerText, info);
  if (!statement.ready || !statement.matches || statement.quarterly !== !!info.quarterly || statement.gstin !== expectedGstin) throw new Error("The statement account or period changed. No download was started.");
  const button = Array.from(document.querySelectorAll("button")).find(el => el.getClientRects().length && !el.disabled && /DOWNLOAD\s+GSTR-2B\s+DETAILS\s*\(EXCEL\)/i.test(el.textContent));
  if (!button) throw new Error("The quarterly Excel download control is unavailable.");
  button.click();
  return { clicked: true };
}
