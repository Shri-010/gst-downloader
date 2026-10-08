async function bindBatchAccount(gstin) {
  const run = await getRun();
  if (!run?.periods) return;
  if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin || "")) throw new Error("Cannot identify the account for this batch.");
  if (run.batchGstin && run.batchGstin !== gstin) throw new Error("The logged-in GST account changed. The batch has stopped to avoid mixing accounts.");
  if (!run.batchGstin) await update({ batchGstin: gstin });
  if (run.r1Action === "download") {
    const saved = (await chrome.storage.local.get("r1Acknowledgements")).r1Acknowledgements || {};
    await update({ r1Requests: saved[gstin] || {} });
  }
}

async function completePeriod(message) {
  const run = await getRun();
  if (!run || !isActive(run)) return;
  if (!run.periods) return update({ stage: "done" }, message);
  const completed = [...(run.completed || []), { period: run.period, message }];
  const nextIndex = run.periodIndex + 1;
  if (nextIndex >= run.periods.length) return update({ stage: "done", completed }, "Batch complete: " + completed.length + " period(s). " + message);
  // Replace per-period state instead of merging download IDs or R1 request flags.
  const next = {
    id: run.id, tabId: run.tabId, returnType: run.returnType, periods: run.periods,
    rangeFrom: run.rangeFrom, rangeTo: run.rangeTo, periodIndex: nextIndex,
    ...(run.r1Phase ? { r1Action: run.r1Action, r1Phase: run.r1Phase, r1Requests: run.r1Requests } : {}),
    period: run.periods[nextIndex], completed, batchGstin: run.batchGstin,
    stage: "navigating", startedAt: Date.now(), deadline: Date.now() + 150000,
    log: [...run.log, message, "Starting period " + (nextIndex + 1) + "/" + run.periods.length + ": " + run.periods[nextIndex]].slice(-30)
  };
  await chrome.storage.session.set({ run: next });
  scheduleAdvance();
}

async function acknowledgeR1AndAdvance() {
  const run = await getRun();
  if (!isActive(run) || run.r1Phase !== "request") return;
  const r1Requests = { ...(run.r1Requests || {}), [run.period]: { acknowledgedAt: Date.now() } };
  if (run.r1Action === "request") {
    const saved = (await chrome.storage.local.get("r1Acknowledgements")).r1Acknowledgements || {};
    await chrome.storage.local.set({ r1Acknowledgements: { ...saved, [run.batchGstin]: { ...(saved[run.batchGstin] || {}), [run.period]: r1Requests[run.period] } } });
    if (run.periodIndex + 1 >= run.periods.length) return update({ stage: "done", r1Requests }, "All GSTR-1 requests accepted. Use Download files when you want to collect them.");
  }
  const last = run.periodIndex + 1 >= run.periods.length;
  const index = last ? 0 : run.periodIndex + 1;
  const message = last ? "All GSTR-1 requests submitted. Returning to the first period to download" : "GSTR-1 request accepted for " + run.period + ". Requesting the next period";
  // Acknowledgement and next cursor are committed together so a worker restart
  // cannot repeat a request whose acknowledgement was already processed.
  const next = {
    id: run.id, tabId: run.tabId, returnType: run.returnType, periods: run.periods,
    rangeFrom: run.rangeFrom, rangeTo: run.rangeTo, periodIndex: index,
    period: run.periods[index], completed: run.completed || [], batchGstin: run.batchGstin,
    r1Action: run.r1Action, r1Phase: last ? "collect" : "request", r1Requests,
    stage: "navigating", startedAt: Date.now(), deadline: Date.now() + 150000,
    log: [...run.log, message].slice(-30)
  };
  await chrome.storage.session.set({ run: next });
  scheduleAdvance();
}
