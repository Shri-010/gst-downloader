importScripts("validation.js", "portal.js", "other-returns.js", "batch.js");

const HOSTS = new Set(["services.gst.gov.in", "return.gst.gov.in", "gstr2b.gst.gov.in"]);
const TERMINAL = new Set(["done", "failed"]);
let queue = Promise.resolve();
const serial = task => { const next = queue.then(task); queue = next.catch(() => {}); return next; };
const getRun = async () => (await chrome.storage.session.get("run")).run;
const isActive = run => run && !TERMINAL.has(run.stage);
const allowed = url => { try { const u = new URL(url); return u.protocol === "https:" && HOSTS.has(u.hostname); } catch { return false; } };

async function update(patch, message) {
  const run = await getRun();
  if (!run) return;
  const next = { ...run, ...patch, updatedAt: Date.now(), log: message ? [...run.log, message].slice(-30) : run.log };
  await chrome.storage.session.set({ run: next });
  if (TERMINAL.has(next.stage)) await chrome.alarms.clear("gst-run");
  return next;
}
async function fail(message) { return update({ stage: "failed", error: message }, message); }

async function reconcileDownload() {
  let run = await getRun();
  if (run?.stage !== "saving") return;
  if (run.r1Files) {
    if (!run.r1AllQueued) return;
    const items = await Promise.all(run.r1Files.map(async file => (await chrome.downloads.search({ id: file.id }))[0]));
    if (items.some(item => !item || item.state === "interrupted" || /text\/html/i.test(item.mime || ""))) return fail("A GSTR-1 part failed or returned a login page. Check Chrome Downloads and retry.");
    if (items.length && items.every(item => item.state === "complete")) await completePeriod("GSTR-1 " + run.period + ": " + items.length + " ZIP file(s) in Downloads/GST-Downloads");
    return;
  }
  if (run.downloadId == null && run.nativeDownload) {
    const candidates = await chrome.downloads.search({ startedAfter: new Date(run.nativeStartedAt).toISOString() });
    const expected = new RegExp(run.nativePattern || "^" + run.nativePrefix + "[0-9]{8}(?: \\([0-9]+\\))?\\.xlsx$", "i");
    const match = candidates.find(item => expected.test((item.filename || "").split(/[\\/]/).pop()));
    if (match) run = await update({ downloadId: match.id, filename: match.filename.split(/[\\/]/).pop() });
  }
  if (run.downloadId == null) return;
  const [item] = await chrome.downloads.search({ id: run.downloadId });
  if (!item) return fail("Chrome no longer has the download. Check Downloads and retry if needed.");
  if (item.state === "complete") {
    if (run.twoBNeedsJson) {
      await update({ stage: "fetching_json", twoBNeedsJson: false, excelFilename: run.filename, excelDownloadId: run.downloadId, downloadId: null, nativeDownload: false, deadline: Date.now() + 90000 }, "Excel saved. Downloading JSON for " + run.period);
      scheduleAdvance();
    } else await completePeriod(run.excelFilename ? "GSTR-2B " + run.period + ": JSON and Excel downloaded" : "Download complete: Downloads/" + run.filename);
  }
  else if (item.state === "interrupted") await fail("Chrome interrupted the download: " + (item.error || "unknown reason") + ". Check Chrome Downloads.");
}

async function advance() {
  let run = await getRun();
  if (!isActive(run)) return;
  if (run.stage === "saving") {
    await reconcileDownload();
    run = await getRun();
    if (isActive(run) && Date.now() > run.deadline) await fail("Chrome has not confirmed download completion. Check Chrome Downloads before retrying.");
    return;
  }
  const tab = await chrome.tabs.get(run.tabId);
  if (!allowed(tab.url)) return fail("The tab left the supported GST pages. Log in normally and retry from a GST dashboard.");
  if (tab.status !== "complete") return;
  const info = periodInfo(run.period);
  info.returnType = run.returnType || "GSTR-2B";
  if (info.returnType !== "GSTR-2B") return advanceOtherReturn(run, tab, info);
  if (Date.now() > run.deadline) return fail("Navigation timed out. Retry from the logged-in GST tab.");
  if (run.stage === "fetching_json") {
    await chrome.scripting.executeScript({ target: { tabId: run.tabId }, files: ["portal.js"] });
    info.quarterly = !!run.quarterly;
    return save2BJson(run, info);
  }
  info.allowPeriodChange = (run.summaryVisits || 0) === 0;
  if (new URL(tab.url).hostname === "gstr2b.gst.gov.in") await update({ summaryVisits: (run.summaryVisits || 0) + 1 });
  await chrome.scripting.executeScript({ target: { tabId: run.tabId }, files: ["portal.js"] });
  let portal;
  await update({ stage: "navigating" }, "Preparing the selected return period");
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: run.tabId }, func: navigatePortal, args: [info] });
    portal = injection?.result;
    if (injection?.result?.message) await update({}, injection.result.message);
    if (injection?.result?.action !== "ready") return;
  } catch (error) {
    const current = await chrome.tabs.get(run.tabId);
    // Navigation can destroy the injected context; the tab event resumes us.
    if (current.status !== "complete" || current.url !== tab.url) return;
    throw error;
  }
  await bindBatchAccount(portal.gstin);
  info.quarterly = !!portal.quarterly;
  await update({ stage: "saving", gstin: portal.gstin, quarterly: !!portal.quarterly, twoBNeedsJson: true, nativeDownload: true, nativeStartedAt: Date.now(), nativePrefix: `${run.period}_${portal.gstin}_GSTR2B${portal.quarterly ? "Q" : ""}_`, deadline: Date.now() + 120000 }, "Downloading GSTR-2B Excel (JSON will follow)");
  await chrome.scripting.executeScript({ target: { tabId: run.tabId }, func: downloadQuarterlyReturn, args: [info, portal.gstin] });
  await reconcileDownload();
}

async function save2BJson(run, info) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: run.tabId }, func: fetchPortalReturn, args: [info] });
  const result = injection?.result;
  if (!result?.raw) throw new Error("The portal returned no data to the extension. Reopen GSTR-2B and retry.");
  const metadata = validateReturn(result.raw, result.expectedGstin, run.period);
  if (run.gstin && run.gstin !== metadata.gstin) throw new Error("The account changed between Excel and JSON. Batch stopped.");
  await bindBatchAccount(metadata.gstin);
  const filename = `GST-Downloads/${metadata.gstin}/${info.fy}/GSTR-2B${run.quarterly ? "Q" : ""}_${run.period}.json`;
  const bytes = new TextEncoder().encode(result.raw);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  // Record intent before invoking Downloads. Never automatically repeat a save
  // after worker interruption, which could create duplicate files.
  await update({ stage: "saving", filename, size: metadata.size, httpStatus: result.httpStatus, elapsedMs: result.elapsedMs, deadline: Date.now() + 120000 }, "Valid return received. Waiting for Chrome to finish saving");
  const id = await chrome.downloads.download({ url: "data:application/json;base64," + btoa(binary), filename, saveAs: false, conflictAction: "uniquify" });
  await update({ downloadId: id });
  await reconcileDownload();
}

function scheduleAdvance() { void serial(advance).catch(error => serial(() => fail(error.message || "The extension could not continue."))); }

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL("popup.html")) return false;
  if (msg?.type === "GET_STATE") {
    serial(async () => { await reconcileDownload(); return { run: await getRun() }; }).then(reply, error => reply({ error: error.message }));
    return true;
  }
  if (msg?.type === "CANCEL") {
    serial(async () => { if (isActive(await getRun())) await fail("Stopped by you. Any generation already requested on GST may continue on the portal."); return { ok: true }; }).then(reply);
    return true;
  }
  if (msg?.type !== "START") return false;
  serial(async () => {
    const rangeFrom = msg.from || msg.period, rangeTo = msg.to || rangeFrom;
    let periods = periodRange(rangeFrom, rangeTo);
    if (msg.cadence === "quarterly") periods = periods.filter(p => periodInfo(p).month % 3 === 0);
    if (!periods.length) throw new Error("This range contains no quarter-ending month. Extend To through March, June, September or December.");
    const returnType = msg.returnType || "GSTR-2B";
    if (!["GSTR-1", "GSTR-2B", "GSTR-3B"].includes(returnType)) throw new Error("Choose GSTR-1, GSTR-2B or GSTR-3B.");
    if (returnType === "GSTR-1" && !["request", "download"].includes(msg.r1Action)) throw new Error("Choose Request files or Download files for GSTR-1.");
    if (isActive(await getRun())) throw new Error("A download is already running. Reopen this popup to see its progress.");
    const tab = await chrome.tabs.get(msg.tabId);
    if (!allowed(tab.url)) throw new Error("Open a logged-in GST portal tab first.");
    await chrome.storage.local.set({ gstPocPeriod: rangeFrom, rangeTo, cadence: msg.cadence || "monthly", returnType });
    await chrome.storage.session.set({ run: { id: crypto.randomUUID(), tabId: tab.id, period: periods[0], periods, periodIndex: 0, completed: [], rangeFrom, rangeTo, returnType, ...(returnType === "GSTR-1" ? { r1Action: msg.r1Action, r1Phase: msg.r1Action === "request" ? "request" : "collect", r1Requests: {} } : {}), stage: "navigating", startedAt: Date.now(), deadline: Date.now() + 150000, log: ["Started " + returnType + ": " + periods.length + " period(s), " + rangeFrom + " to " + rangeTo] } });
    await chrome.alarms.create("gst-run", { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    return { ok: true };
  }).then(value => { reply(value); scheduleAdvance(); }, error => reply({ error: error.message }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== "complete") return;
  void serial(async () => {
    const run = await getRun();
    if (!isActive(run) || run.stage !== "navigating") return false;
    if (run.tabId === tabId) return true;
    // Some portal links create about:blank first and assign the SSO URL later.
    if (tab.openerTabId === run.tabId && allowed(tab.url)) {
      await update({ tabId });
      return true;
    }
    return false;
  }).then(needed => { if (needed) scheduleAdvance(); });
});
chrome.tabs.onCreated.addListener(tab => {
  void serial(async () => {
    const run = await getRun();
    if (isActive(run) && run.stage === "navigating" && tab.openerTabId === run.tabId && allowed(tab.pendingUrl || tab.url)) await update({ tabId: tab.id });
  });
});
chrome.tabs.onRemoved.addListener(tabId => {
  void serial(async () => { const run = await getRun(); if (isActive(run) && run.tabId === tabId && run.stage !== "saving") await fail("The GST tab was closed. Open the portal and retry."); });
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "gst-run") scheduleAdvance(); });
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state || delta.error) void serial(async () => { const run = await getRun(); if (run?.downloadId === delta.id || run?.nativeDownload || run?.r1Files) await reconcileDownload(); });
});
chrome.downloads.onCreated.addListener(() => { void serial(reconcileDownload); });
