// Photo attachments. jcode's `message` (and `soft_interrupt`) request takes
// `images: [[media_type, base64_data], ...]` and puts them in front of the
// text as image blocks. Phone photos are large, so they are scaled down to
// what vision models actually use before they go over the wire.

export const MAX_EDGE = 1568; // px, long edge (more is downscaled by the model anyway)
export const MAX_BYTES = 3.5 * 1024 * 1024; // stay well under provider per-image limits
export const MAX_IMAGES = 6;
const PASSTHROUGH = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// Size that fits inside max x max, keeping the aspect ratio. Never upscales.
export function fitWithin(w, h, max = MAX_EDGE) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// Send the file as is, or re-encode it as JPEG?
export function needsReencode({ type, size, width, height }) {
  return !PASSTHROUGH.includes(type) || size > MAX_BYTES || Math.max(width, height) > MAX_EDGE;
}

export function base64FromBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// File -> { mediaType, data (base64), previewUrl, width, height, bytes }.
// Browser only (createImageBitmap + canvas).
export async function prepareImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const meta = { type: file.type, size: file.size, width: bmp.width, height: bmp.height };
    if (!needsReencode(meta)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { mediaType: file.type, data: base64FromBytes(bytes), previewUrl: URL.createObjectURL(file), width: bmp.width, height: bmp.height, bytes: bytes.length };
    }
    const { w, h } = fitWithin(bmp.width, bmp.height);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // JPEG has no alpha: transparent areas become white, not black
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", 0.85));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { mediaType: "image/jpeg", data: base64FromBytes(bytes), previewUrl: URL.createObjectURL(blob), width: w, height: h, bytes: bytes.length };
  } finally {
    bmp.close && bmp.close();
  }
}
