// Pairing links: https://<jphone>/#pair=HOST:PORT:CODE
// The fragment never reaches any server (browsers do not send it), and the
// app removes it from the address bar as soon as it has read it.

// Returns { host, port, code } or null. HOST may be a name, an IPv4 address,
// or a bracketed IPv6 address ("[fd7a:115c::1]").
export function parsePairFragment(hash) {
  if (!hash) return null;
  let raw = String(hash).replace(/^#/, "");
  const m = /(?:^|&)pair=([^&]*)/.exec(raw);
  if (!m) return null;
  try {
    raw = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const parts = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5}):(\d{3} ?\d{3})$/.exec(raw.trim());
  if (!parts) return null;
  const port = Number(parts[2]);
  if (port < 1 || port > 65535) return null;
  return { host: parts[1], port: String(port), code: parts[3].replace(/\D/g, "") };
}

export function pairLink(appUrl, host, port, code) {
  return `${appUrl.replace(/[#?].*$/, "").replace(/\/?$/, "/")}#pair=${host}:${port}:${code}`;
}
