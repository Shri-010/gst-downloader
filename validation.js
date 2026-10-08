/* Shared pure helpers. No account data is logged or persisted here. */
function periodInfo(period) {
  if (!/^(0[1-9]|1[0-2])20\d{2}$/.test(period)) throw new Error("Enter a valid period as MMYYYY, for example 032026.");
  const month = Number(period.slice(0, 2));
  const year = Number(period.slice(2));
  const start = month >= 4 ? year : year - 1;
  return { period, month, year, fy: `${start}-${String(start + 1).slice(-2)}`, quarter: Math.floor(((month + 8) % 12) / 3) + 1 };
}

function periodRange(from, to) {
  const first = periodInfo(from), last = periodInfo(to);
  const start = first.year * 12 + first.month - 1, end = last.year * 12 + last.month - 1;
  if (end < start) throw new Error("To period must be the same as or later than From period.");
  if (end - start >= 120) throw new Error("Choose at most 120 months per batch.");
  return Array.from({ length: end - start + 1 }, (_, i) => String((start + i) % 12 + 1).padStart(2, "0") + Math.floor((start + i) / 12));
}

function validateReturn(text, expectedGstin, period) {
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(/^\s*</.test(text) ? "The portal returned HTML, possibly a login or access-denied page. Log in again and open GSTR-2B." : "The portal did not return valid JSON.");
  }
  if (!json || typeof json !== "object" || Array.isArray(json) || json.error || json.errors || json.error_cd || json.errorCode || json.success === false) {
    throw new Error("The portal returned an error or an unexpected JSON response. No file was saved.");
  }
  const data = json.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || data.error || data.errors || data.error_cd || data.success === false || !/^[0-9]{2}[A-Z0-9]{13}$/.test(data.gstin || "")) {
    throw new Error("The response does not contain the expected GSTR-2B data and GSTIN. No file was saved.");
  }
  if (!expectedGstin || data.gstin !== expectedGstin) throw new Error("The response GSTIN does not match the open GSTR-2B page. No file was saved.");
  if (data.rtnprd != null && String(data.rtnprd) !== period) throw new Error("The response period does not match the requested month. No file was saved.");
  return { gstin: data.gstin, size: new TextEncoder().encode(text).length };
}
