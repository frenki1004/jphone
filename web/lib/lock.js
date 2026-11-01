// App lock: the device token, encrypted with a key derived from a PIN.
// PBKDF2-SHA-256 -> AES-GCM-256 via WebCrypto (needs a secure context:
// https, or localhost). A wrong PIN fails AES-GCM's authentication check.
//
// This stops someone who picks up an unlocked phone. It is not a vault: a
// short PIN can be brute-forced offline by anyone who copies the browser's
// storage. Revoke the device (`jcode pair --revoke`) if the phone is lost.

export const LOCK_ITERATIONS = 310000;
export const RELOCK_AFTER_MS = 5 * 60 * 1000; // in the background this long -> ask again

export const lockAvailable = () => !!(globalThis.crypto && globalThis.crypto.subtle);

const utf8 = (s) => new TextEncoder().encode(s); // lazy: some test engines lack TextEncoder
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pin, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", utf8(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function lockToken(pin, token, iterations = LOCK_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8(token));
  return { v: 1, iter: iterations, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

// Resolves to the token, or rejects (wrong PIN or damaged data).
export async function unlockToken(lock, pin) {
  const key = await deriveKey(pin, unb64(lock.salt), lock.iter);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(lock.iv) }, key, unb64(lock.ct));
  return new TextDecoder().decode(pt);
}

// Seconds to wait before the next try: free for 4 wrong PINs, then 30 s,
// doubling up to 15 minutes.
export function lockoutSeconds(fails) {
  if (fails < 5) return 0;
  return Math.min(900, 30 * 2 ** (fails - 5));
}

export function validPin(pin) {
  return typeof pin === "string" && /^\d{4,12}$/.test(pin);
}
