// Headless WebKit screenshot at phone size (macOS). Same engine as Safari on iPhone.
//   swiftc -O tools/shot.swift -o tools/shot
//   tools/shot <url> <out.png> [width] [height] [waitSecs] [jsBeforeShot] [jsProbePrinted]
// The window sits on screen at ~1% opacity so WebKit does not throttle timers.
import AppKit
import WebKit

let args = CommandLine.arguments
let url = URL(string: args[1])!
let out = args[2]
let w = Double(args.count > 3 ? args[3] : "393")!
let h = Double(args.count > 4 ? args[4] : "852")!
let wait = Double(args.count > 5 ? args[5] : "2.5")!
let js = args.count > 6 ? args[6] : ""
let probe = args.count > 7 ? args[7] : ""

class D: NSObject, WKNavigationDelegate {
  func webView(_ wv: WKWebView, didFinish n: WKNavigation!) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
      let run: () -> Void = {
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
          if !probe.isEmpty { let sem = DispatchGroup(); sem.enter(); wv.evaluateJavaScript(probe) { r, e in print("probe:", r ?? "nil", e.map { "\($0)" } ?? ""); sem.leave() }; sem.notify(queue: .main) {} }
          let cfg = WKSnapshotConfiguration()
          cfg.rect = CGRect(x: 0, y: 0, width: w, height: h)
          wv.takeSnapshot(with: cfg) { img, err in
            guard let img = img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { print("snapshot failed", err as Any); exit(1) }
            try! png.write(to: URL(fileURLWithPath: out)); print("wrote", out); exit(0)
          }
        }
      }
      if js.isEmpty { run() } else {
        wv.evaluateJavaScript(js) { r, e in if let e = e { print("js error:", e) }; run() }
      }
    }
  }
  func webView(_ wv: WKWebView, didFail n: WKNavigation!, withError e: Error) { print("fail", e); exit(1) }
  func webView(_ wv: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { print("fail", e); exit(1) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let conf = WKWebViewConfiguration()
conf.websiteDataStore = .nonPersistent()
let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: w, height: h), configuration: conf)
wv.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
let win = NSWindow(contentRect: wv.frame, styleMask: [.borderless], backing: .buffered, defer: false)
win.contentView = wv
// Keep the window on screen (nearly transparent, ignores clicks) so WebKit
// treats the page as visible and does not throttle timers.
win.setFrameOrigin(NSPoint(x: 0, y: 0))
win.alphaValue = 0.01
win.ignoresMouseEvents = true
win.level = .floating
win.orderFrontRegardless()
let d = D()
wv.navigationDelegate = d
wv.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + wait + 30) { print("timeout"); exit(2) }
app.run()
