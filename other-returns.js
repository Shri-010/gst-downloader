// Worker orchestration for native GSTR-1 ZIP and GSTR-3B PDF exports.
async function advanceOtherReturn(run, tab, info) {
  if (Date.now() > run.deadline) return fail(run.r1Waiting ? "GSTR-1 generation did not finish within 25 minutes. Retry later; the portal may still be preparing it." : "Return navigation timed out. Retry from the logged-in GST tab.");
  if (tab.status !== "complete") return;
  await chrome.scripting.executeScript({ target: { tabId: run.tabId }, files: ["portal.js"] });
  const execute = async (func, args) => (await chrome.scripting.executeScript({ target: { tabId: run.tabId }, func, args }))[0]?.result;
  if (run.returnType === "GSTR-1" && run.r1Prepared && new URL(tab.url).pathname === "/returns/auth/gstr/offlinedownload") {
    if (!run.r1Waiting) {
      const collecting = run.r1Phase === "collect";
      if (collecting && !run.r1Requests?.[run.period]) throw new Error("No saved GSTR-1 request for this account and period. Use Request files first, then Download files.");
      run = await update({ stage: "waiting", r1Waiting: true, deadline: Date.now() + 25 * 60000, requestClicks: 0, generationObserved: collecting }, collecting ? "Checking the previously requested GSTR-1 file for " + run.period : "Requesting fresh GSTR-1 JSON for " + run.period);
    }
    let page = await execute(inspectR1, [info, run.gstin]);
    if (page.generating && !run.generationObserved) run = await update({ generationObserved: true }, "GSTR-1 generation acknowledged. Checking every 30 seconds");
    if (run.r1Phase === "request" && run.generationObserved) return acknowledgeR1AndAdvance();
    if (page.links.length && run.generationObserved) {
      await update({ stage: "saving", r1Files: [], r1AllQueued: false, deadline: Date.now() + 5 * 60000 }, "GSTR-1 ready: downloading " + page.links.length + " file(s)");
      const files = [];
      for (const link of page.links) {
        const filename = `GST-Downloads/${run.gstin}/${info.fy}/GSTR-1_${run.period}_Part-${link.part}.zip`;
        const id = await chrome.downloads.download({ url: link.url, filename, saveAs: false, conflictAction: "uniquify" });
        files.push({ id, filename });
        await update({ r1Files: [...files] });
      }
      await update({ r1AllQueued: true });
      await reconcileDownload();
      return;
    }
    // The first click may reveal an old file. The second requests fresh data.
    // After acknowledgement, a click checks generation status. Links are always
    // inspected FIRST so ready data is never accidentally regenerated.
    if (!run.generationObserved && run.requestClicks >= 2 && page.cached) return fail("GST is still offering an older file after the fresh-file request. No old file was downloaded.");
    if (!run.generationObserved && run.requestClicks >= 2 && !page.generating) return fail("GST did not acknowledge the file-generation request. Retry after checking the portal message.");
    run = await update({ requestClicks: (run.requestClicks || 0) + 1 });
    await execute(clickR1Generate, [info, run.gstin]);
    // Let the portal finish its status request; this is not a generation delay.
    await new Promise(resolve => setTimeout(resolve, 1200));
    page = await execute(inspectR1, [info, run.gstin]);
    if (page.generating && !run.generationObserved) {
      await update({ generationObserved: true }, "GSTR-1 generation acknowledged for " + run.period);
      if (run.r1Phase === "request") return acknowledgeR1AndAdvance();
    }
    return;
  }
  await update({ stage: "navigating" }, "Preparing " + run.returnType + " for " + run.period);
  let result;
  try { result = await execute(navigatePortal, [info]); }
  catch (error) {
    const current = await chrome.tabs.get(run.tabId);
    if (current.status !== "complete" || current.url !== tab.url) return;
    throw error;
  }
  if (result?.message) await update({}, result.message);
  if (result?.action !== "return-download-ready") return;
  if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(result.gstin || "")) throw new Error("The return's GSTIN is unavailable.");
  await bindBatchAccount(result.gstin);
  if (run.returnType === "GSTR-3B") {
    await update({ stage: "saving", nativeDownload: true, nativeStartedAt: Date.now(), nativePattern: `^GSTR3B_${result.gstin}_${run.period}(?: \\([0-9]+\\))?\\.pdf$`, deadline: Date.now() + 120000 }, "Downloading GSTR-3B PDF");
  } else {
    await update({ stage: "navigating", gstin: result.gstin, r1Prepared: true }, "Opening GSTR-1 file-generation page");
  }
  try { await execute(clickReturnDownload, [run.returnType, result.gstin]); }
  catch (error) {
    const current = await chrome.tabs.get(run.tabId);
    if (run.returnType !== "GSTR-1" || current.url === tab.url && current.status === "complete") throw error;
  }
  await reconcileDownload();
}
