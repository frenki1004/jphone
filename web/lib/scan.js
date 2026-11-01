// Pairing from a QR code or a pasted link. Pure helpers plus a small camera
// scanner. The scanner prefers the browser's own BarcodeDetector (Chrome on
// Android) and falls back to the vendored jsQR (iPhone Safari has no detector),
// which is loaded only when you tap Scan.
import { parsePairFragment } from "./pairlink.js";

// Anything you might paste or scan -> { host, port, code } or null.
// Accepts a full pairing link, just its "#pair=..." part, or "HOST:PORT:CODE".
export function parsePairText(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const hash = t.indexOf("#");
  if (hash >= 0) return parsePairFragment(t.slice(hash));
  if (/^pair=/.test(t)) return parsePairFragment("#" + t);
  return parsePairFragment("#pair=" + t);
}

let jsqrLoading = null;
function loadJsQR() {
  if (globalThis.jsQR) return Promise.resolve(globalThis.jsQR);
  jsqrLoading =
    jsqrLoading ||
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "vendor/jsQR.js";
      s.onload = () => (globalThis.jsQR ? resolve(globalThis.jsQR) : reject(new Error("QR decoder did not load")));
      s.onerror = () => {
        jsqrLoading = null;
        reject(new Error("QR decoder did not load"));
      };
      document.head.appendChild(s);
    });
  return jsqrLoading;
}

export const cameraAvailable = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;

// Starts the back camera in `video` and resolves with the first QR text found.
// Call the returned stop() to cancel (the promise then rejects with "stopped").
export function scanQR(video) {
  let stopped = false;
  let stream = null;
  let raf = 0;
  let stopReject = null;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    if (stopReject) stopReject(new Error("stopped"));
  };
  const result = new Promise(async (resolve, reject) => {
    stopReject = reject;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if (stopped) return stop();
      video.srcObject = stream;
      video.setAttribute("playsinline", "");
      video.muted = true;
      await video.play();
      let detect;
      if ("BarcodeDetector" in window) {
        const bd = new window.BarcodeDetector({ formats: ["qr_code"] });
        detect = async () => {
          const codes = await bd.detect(video);
          return codes.length ? codes[0].rawValue : null;
        };
      } else {
        const jsQR = await loadJsQR();
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        detect = async () => {
          const w = video.videoWidth;
          const h = video.videoHeight;
          if (!w || !h) return null;
          const scale = Math.min(1, 640 / Math.max(w, h)); // small frames decode faster
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const r = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          return r ? r.data : null;
        };
      }
      const tick = async () => {
        if (stopped) return;
        try {
          const text = await detect();
          if (text) {
            stopReject = null;
            stop();
            return resolve(text);
          }
        } catch {
          /* frame not ready */
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      stop();
      reject(e && e.name === "NotAllowedError" ? new Error("Camera access was denied. Allow it in Settings → Safari → Camera, or paste the link instead.") : e);
    }
  });
  return { result, stop };
}
