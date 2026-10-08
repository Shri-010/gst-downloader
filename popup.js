const $ = id => document.getElementById(id);
let tabId = null, busy = false;
const terminal = stage => stage === "done" || stage === "failed";
function showActions() {
  const r1 = $("returnType").value === "GSTR-1";
  $("start").hidden = r1;
  $("requestR1").hidden = $("downloadR1").hidden = !r1;
  for (const id of ["start", "requestR1", "downloadR1"]) $(id).disabled = busy || tabId == null;
}
function render(run) {
  busy = !!run && !terminal(run.stage);
  $("start").disabled = busy || tabId == null;
  $("period").disabled = busy;
  $("periodTo").disabled = busy;
  $("cadence").disabled = busy;
  $("returnType").disabled = busy;
  $("cancel").hidden = !busy;
  showActions();
  if (!run) return;
  if (busy && run.rangeFrom) {
    $("period").value = run.rangeFrom;
    $("periodTo").value = run.rangeTo;
    $("returnType").value = run.returnType;
  }
  showActions();
  $("batchProgress").textContent = run.periods ? (run.r1Phase ? `${run.r1Phase === "request" ? "Requesting files" : "Downloading files"} — ${Object.keys(run.r1Requests || {}).length}/${run.periods.length} requested, ${(run.completed || []).length}/${run.periods.length} downloaded — ${run.period}` : `${(run.completed || []).length}/${run.periods.length} periods complete — current period: ${run.period}`) : "";
  $("status").className = run.stage;
  $("status").textContent = run.stage === "done" ? (run.r1Action === "request" ? "Requests complete � use Download files to collect them" : "Download complete") : run.stage === "failed" ? run.error : "Working: " + run.stage + "…";
  $("log").replaceChildren(...run.log.map(line => { const item = document.createElement("li"); item.textContent = line; return item; }));
}
async function refresh() {
  try { const response = await chrome.runtime.sendMessage({ type: "GET_STATE" }); if (response.error) throw new Error(response.error); render(response.run); }
  catch (error) { $("status").textContent = error.message; }
}
async function startRun(r1Action) {
  try {
    const period = $("period").value.trim(), to = $("periodTo").value.trim(); periodRange(period, to);
    for (const id of ["start", "requestR1", "downloadR1"]) $(id).disabled = true;
    const response = await chrome.runtime.sendMessage({ type: "START", r1Action, from: period, to, cadence: $("cadence").value, tabId, returnType: $("returnType").value });
    if (response.error) throw new Error(response.error);
    await refresh();
  } catch (error) { $("status").className = "failed"; $("status").textContent = error.message; showActions(); }
}
$("start").addEventListener("click", () => startRun());
$("requestR1").addEventListener("click", () => startRun("request"));
$("downloadR1").addEventListener("click", () => startRun("download"));
$("returnType").addEventListener("change", () => { showActions(); previewRange(); });
$("cancel").addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: "CANCEL" }); await refresh(); });
function previewRange() {
  try {
    let periods = periodRange($("period").value.trim(), $("periodTo").value.trim());
    if ($("cadence").value === "quarterly") periods = periods.filter(p => periodInfo(p).month % 3 === 0);
    $("rangePreview").textContent = periods.length ? `${periods.length} period(s), processed one after another. Both dates are included.` : "No quarter-ending month in this range.";
  } catch { $("rangePreview").textContent = "Enter From and To periods, for example 042025 to 032026."; }
}
for (const id of ["period", "periodTo", "cadence"]) $(id).addEventListener("input", previewRange);
chrome.storage.onChanged.addListener((changes, area) => { if (area === "session" && changes.run) render(changes.run.newValue); });
(async () => {
  const saved = await chrome.storage.local.get(["gstPocPeriod", "rangeTo", "cadence", "returnType"]);
  if (["GSTR-1", "GSTR-2B", "GSTR-3B"].includes(saved.returnType)) $("returnType").value = saved.returnType;
  // Last completed calendar month is a starting suggestion, not a generation guarantee.
  const previous = new Date(); previous.setDate(1); previous.setMonth(previous.getMonth() - 1);
  $("period").value = saved.gstPocPeriod || String(previous.getMonth() + 1).padStart(2, "0") + previous.getFullYear();
  $("periodTo").value = saved.rangeTo || $("period").value;
  $("cadence").value = saved.cadence === "quarterly" ? "quarterly" : "monthly";
  previewRange();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = ""; try { const url = new URL(tab?.url); if (url.protocol === "https:") host = url.hostname; } catch {}
  if (["services.gst.gov.in", "return.gst.gov.in", "gstr2b.gst.gov.in"].includes(host)) {
    tabId = tab.id; $("tabCheck").textContent = "GST tab: " + host;
  } else $("tabCheck").textContent = "Open your logged-in GST tab, then reopen this extension.";
  await refresh();
})().catch(error => { $("status").textContent = error.message; });
