import AppKit
import CoreGraphics
import Darwin

func argument(_ name: String) -> String {
  guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { exit(2) }
  return CommandLine.arguments[index + 1]
}
let nonce = argument("--nonce")
let probe = argument("--probe")
let snapshot = argument("--snapshot")
let foregroundRequest = argument("--foreground-request")
let stop = argument("--stop")
guard nonce.count == 32 && nonce.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { exit(2) }
let title = "App Shot owned \(nonce)"
// Keep body text distinct from the title so native chrome filtering retains it.
let contentLabel = "App Shot content \(nonce)"

final class Pattern: NSView {
  override var isFlipped: Bool { true }
  override var isOpaque: Bool { true }
  override func draw(_ dirtyRect: NSRect) {
    NSColor.white.setFill(); bounds.fill()
    for (index, character) in nonce.enumerated() {
      let n = Int(String(character), radix: 16)!
      NSColor(srgbRed: CGFloat(40 + (n & 3) * 60) / 255,
              green: CGFloat(n & 4 != 0 ? 220 : 40) / 255,
              blue: CGFloat(n & 8 != 0 ? 220 : 40) / 255, alpha: 1).setFill()
      NSRect(x: CGFloat(72 + (index % 8) * 64), y: CGFloat(24 + (index / 8) * 64), width: 48, height: 48).fill()
    }
  }
}
final class OwnedWindow: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}
final class Delegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  func applicationDidFinishLaunching(_ notification: Notification) {
    // Borderless, opaque, shadow-free: every returned pixel belongs to this fixture.
    window = OwnedWindow(contentRect: NSRect(x: 100, y: 100, width: 640, height: 320),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.title = title; window.isOpaque = true; window.backgroundColor = .white
    window.hasShadow = false
    let pattern = Pattern(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
    let label = NSTextField(labelWithString: contentLabel)
    label.frame = NSRect(x: 12, y: 284, width: 616, height: 24)
    label.textColor = .black; label.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
    label.setAccessibilityLabel(contentLabel)
    pattern.addSubview(label); window.contentView = pattern
    window.makeKeyAndOrderFront(nil)
    // Initial display is not foreground evidence. A private, one-shot request
    // below may activate only this directly owned synthetic application.
    window.displayIfNeeded()
    var previous = ""
    var foregroundRequested = false
    Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [self] _ in
      if FileManager.default.fileExists(atPath: stop) { window.close(); NSApp.terminate(nil); return }
      if !foregroundRequested,
         let request = try? String(contentsOfFile: foregroundRequest, encoding: .utf8),
         request == nonce {
        foregroundRequested = true // Consume before activation; never retry.
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
      }
      guard let token = try? String(contentsOfFile: probe, encoding: .utf8),
            token != previous, token.count == 32 else { return }
      previous = token
      let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(window.windowNumber)) as? [[String: Any]]
      guard let row = rows?.first, let rect = row[kCGWindowBounds as String] as? [String: Any] else { return }
      let receipt: [String: Any] = ["token": token, "nonce": nonce, "pid": Int(getpid()),
        "windowId": window.windowNumber, "windowTitle": window.title,
        "executable": Bundle.main.executableURL!.path, "bundle": Bundle.main.bundlePath,
        "active": NSApp.isActive && NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid(),
        "bounds": ["x": rect["X"]!, "y": rect["Y"]!, "width": rect["Width"]!, "height": rect["Height"]!]]
      if let data = try? JSONSerialization.data(withJSONObject: receipt) {
        try? data.write(to: URL(fileURLWithPath: snapshot), options: .atomic)
      }
    }
  }
}
let application = NSApplication.shared
if application.activationPolicy() != .regular { _ = application.setActivationPolicy(.regular) }
guard application.activationPolicy() == .regular else { exit(3) }
let delegate = Delegate(); application.delegate = delegate
// Even a dead launcher cannot leave a permanent fixture behind.
Timer.scheduledTimer(withTimeInterval: 90, repeats: false) { _ in application.terminate(nil) }
application.run()
