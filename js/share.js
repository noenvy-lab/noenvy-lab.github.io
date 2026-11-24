// Packs a sheet, or one housemate's reply, into the part of a link after "#".
// Browsers do not send that part to any server, so the numbers stay between
// the people who pass the link around.

export function encode(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Returns the data, or null when the text is not something encode() produced.
export function decode(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 20000 || /[^A-Za-z0-9_-]/.test(text)) return null;
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

// Reads "#s=...&me=1" or "#in=..." into {sheet, me, reply}; absent parts are null.
export function parseFragment(hash) {
  const out = { sheet: null, me: null, reply: null };
  if (typeof hash !== "string") return out;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (params.has("s")) out.sheet = decode(params.get("s"));
  if (params.has("in")) out.reply = decode(params.get("in"));
  if (params.has("me") && /^[0-7]$/.test(params.get("me"))) out.me = Number(params.get("me"));
  return out;
}

export function sheetLink(baseUrl, sheetData, me = null) {
  return `${baseUrl}#s=${encode(sheetData)}${me === null ? "" : `&me=${me}`}`;
}

export function replyLink(baseUrl, reply) {
  return `${baseUrl}#in=${encode(reply)}`;
}
