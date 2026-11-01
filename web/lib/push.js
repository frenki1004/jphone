// Optional Web Push through the push relay on the Mac (tools/push-relay.py).
// Pure helpers, no DOM: the app wires them to fetch and the PushManager.

// "BPxx..." (base64url, as the relay sends its VAPID key) -> Uint8Array for
// pushManager.subscribe({ applicationServerKey }).
export function urlB64ToBytes(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (String(s).length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

// The relay only needs the endpoint and the two keys (no expirationTime etc).
export function subscriptionBody(sub, hide) {
  const j = typeof sub.toJSON === "function" ? sub.toJSON() : sub;
  return { subscription: { endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } }, hide: !!hide };
}

// Is an existing browser subscription still tied to this relay's key? (A new
// relay key, e.g. after deleting its state file, needs a fresh subscription.)
export function sameKey(sub, vapidKey) {
  const k = sub && sub.options && sub.options.applicationServerKey;
  if (!k) return true; // browser does not say: assume yes, the relay drops dead ones
  const a = new Uint8Array(k);
  const b = urlB64ToBytes(vapidKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// What the service worker shows for a push payload. Never throws.
export function pushNotice(data) {
  let d = data;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      d = { body: d };
    }
  }
  d = d && typeof d === "object" ? d : {};
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  return { title: str(d.title, 120) || "jcode", body: str(d.body, 300), tag: str(d.tag, 120) || "jphone" };
}
