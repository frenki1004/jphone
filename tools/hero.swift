// Compose README hero: three phone screenshots side by side on a dark canvas.
//   swiftc -O tools/hero.swift -o tools/hero && tools/hero docs/img/hero.png docs/img/pair.png docs/img/live.png docs/img/drawer.png
import AppKit

let args = CommandLine.arguments
let out = args[1]
let inputs = args.dropFirst(2).compactMap { NSImage(contentsOfFile: $0) }
guard !inputs.isEmpty else { print("no images"); exit(1) }

let phoneW: CGFloat = 393, phoneH: CGFloat = 852, gap: CGFloat = 48, pad: CGFloat = 64, radius: CGFloat = 46
let W = pad * 2 + phoneW * CGFloat(inputs.count) + gap * CGFloat(inputs.count - 1)
let H = pad * 2 + phoneH
let scale: CGFloat = 2

let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W * scale), pixelsHigh: Int(H * scale), bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: W, height: H)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

// background: near-black with a soft mint glow
NSColor(red: 0.04, green: 0.04, blue: 0.055, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: W, height: H).fill()
let glow = NSGradient(colors: [NSColor(red: 0.30, green: 0.85, blue: 0.65, alpha: 0.16), NSColor(red: 0.30, green: 0.85, blue: 0.65, alpha: 0)])!
glow.draw(in: NSRect(x: 0, y: 0, width: W, height: H), relativeCenterPosition: NSPoint(x: 0, y: -0.2))

for (i, img) in inputs.enumerated() {
  let x = pad + CGFloat(i) * (phoneW + gap)
  let r = NSRect(x: x, y: pad, width: phoneW, height: phoneH)
  // shadow + bezel
  let sh = NSShadow(); sh.shadowBlurRadius = 40; sh.shadowOffset = NSSize(width: 0, height: -14); sh.shadowColor = NSColor(white: 0, alpha: 0.6)
  NSGraphicsContext.saveGraphicsState(); sh.set()
  NSColor(white: 0.16, alpha: 1).setFill()
  NSBezierPath(roundedRect: r.insetBy(dx: -6, dy: -6), xRadius: radius + 6, yRadius: radius + 6).fill()
  NSGraphicsContext.restoreGraphicsState()
  // screen
  NSGraphicsContext.saveGraphicsState()
  NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius).addClip()
  img.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  // dynamic island
  NSColor.black.setFill()
  NSBezierPath(roundedRect: NSRect(x: x + phoneW / 2 - 62, y: pad + phoneH - 11 - 36, width: 124, height: 36), xRadius: 18, yRadius: 18).fill()
}

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote", out)
