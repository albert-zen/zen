import AppKit
import Darwin

func argument(_ name: String) -> String? {
  guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
  return CommandLine.arguments[index + 1]
}
// LaunchServices stdio forwarding is not the receiver lifecycle authority.
// The harness creates this private file before launch; direct writes also cover
// failures before NSApplication has finished launching.
let eventOutput: FileHandle = {
  guard let path = argument("--events-file") else { return .standardOutput }
  guard let handle = FileHandle(forWritingAtPath: path) else { exit(4) }
  return handle
}()
func report(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
  eventOutput.write(data); eventOutput.write(Data([10]))
}
// Failure-only identity inspection of one PID named by the production fence.
// This branch creates no NSApplication/window and performs no activation/input.
if let rawPID = argument("--inspect-pid") {
  guard let pid = Int32(rawPID), pid > 0 else { exit(2) }
  var identity: [String: Any] = ["kind": "owned-occluder-identity", "pid": Int(pid),
    "observation": "later_exact_pid_read_not_lifetime_binding"]
  let app = NSRunningApplication(processIdentifier: pid)
  // A window owner need not be an AppKit application. Read the same PID's
  // executable via libproc when NSRunningApplication cannot identify it.
  // Apple's xnu bsd/sys/proc_info.h defines the maximum as 4 * MAXPATHLEN;
  // param.h aliases MAXPATHLEN to PATH_MAX, syslimits.h defines PATH_MAX=1024.
  // Use that bounded value because Swift does not import the compound macro.
  let processPathCapacity = 4096
  var buffer = [CChar](repeating: 0, count: processPathCapacity)
  let pathSize = proc_pidpath(pid, &buffer, UInt32(processPathCapacity))
  let path = app?.executableURL?.path ?? (pathSize > 0 ? String(cString: buffer) : "")
  identity["available"] = !path.isEmpty || app != nil
  identity["bundleId"] = app?.bundleIdentifier.map { $0 as Any } ?? NSNull()
  identity["executable"] = path.isEmpty ? NSNull() : URL(fileURLWithPath: path).lastPathComponent as Any
  identity["locationClass"] = path.hasPrefix("/System/") ? "system" : path.hasPrefix("/Applications/") ? "applications" : "other_or_unavailable"
  report(identity)
  exit(0)
}
report(["kind": "owned-receiver-starting", "pid": Int(getpid()), "bundlePath": Bundle.main.bundlePath])

// Independently observed receiver evidence, not CGEvent posting receipts. This
// fixture only records events delivered to its own pad; no global event monitor.
final class DragReceiver: NSView {
  var start: NSPoint?
  var samples = 0
  var showResult: ((String) -> Void)?
  override func mouseDown(with event: NSEvent) {
    start = convert(event.locationInWindow, from: nil)
    samples = 0
  }
  override func mouseDragged(with event: NSEvent) { if start != nil { samples += 1 } }
  override func mouseUp(with event: NSEvent) {
    guard let from = start else { return }
    let to = convert(event.locationInWindow, from: nil)
    let receipt: [String: Any] = ["kind": "owned-drag-received", "pid": Int(getpid()),
      "windowId": window?.windowNumber ?? 0, "windowTitle": window?.title ?? "",
      "downReceived": true, "draggedReceived": samples, "upReceived": true,
      "from": ["x": from.x, "y": from.y], "to": ["x": to.x, "y": to.y]]
    report(receipt)
    if samples > 0 { showResult?("PASS native drag received \(samples) samples and release") }
    start = nil
  }
}
final class NoninteractiveOverlay: NSWindow {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}
final class Delegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  var window: NSWindow!
  var overlay: NSWindow?
  var pressCount = 0
  let output = NSTextField(labelWithString: "Not pressed")
  @objc func pressed(_ sender: NSButton) { pressCount += 1; output.stringValue = "PASS native button pressed \(pressCount)" }
  func reportFocus(_ event: String, token: String? = nil) {
    guard let window else { return }
    var state: [String: Any] = ["kind": "owned-focus-state", "event": event,
      "pid": Int(getpid()), "windowId": window.windowNumber,
      "isActive": NSApp.isActive, "isKeyWindow": window.isKeyWindow,
      "isMainWindow": window.isMainWindow, "canBecomeKey": window.canBecomeKey,
      "activationPolicy": NSApp.activationPolicy().rawValue,
      "frontmostPID": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)]
    if let token { state["token"] = token }
    report(state)
  }
  func reportPointerHit(_ token: String, x: Double, y: Double, selectedCGWindowId: Int) {
    guard let window, let primary = NSScreen.screens.first,
          primary.frame.minX == 0, primary.frame.minY == 0 else {
      report(["kind": "owned-pointer-hit-witness", "token": token, "available": false,
        "reason": "primary_coordinate_origin_unavailable"])
      return
    }
    // CG/AX global coordinates start at the primary display's top-left;
    // AppKit screen coordinates start at that display's bottom-left. Do not
    // use NSScreen.main (which follows key-window focus) or backing pixels.
    let point = NSPoint(x: x, y: primary.frame.maxY - y)
    let hit = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: 0)
    report(["kind": "owned-pointer-hit-witness", "token": token, "available": true,
      "pid": Int(getpid()), "ownNSWindowNumber": window.windowNumber,
      "isActive": NSApp.isActive, "isKeyWindow": window.isKeyWindow,
      "frontmostPID": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1),
      "observation": "after_refusal_not_atomic_with_dispatch_fence",
      "selectedCGWindowId": selectedCGWindowId, "hitNSWindowNumber": hit,
      "matchesOwnNSWindowNumber": hit == window.windowNumber,
      "ownNSNumberEqualsSelectedCGIdObserved": window.windowNumber == selectedCGWindowId,
      "cgPoint": ["x": x, "y": y], "appKitPoint": ["x": point.x, "y": point.y],
      "primaryHeight": primary.frame.height, "belowWindowNumber": 0,
      "scope": "read_only_mouse_down_hit_snapshot_not_delivery_or_namespace_proof"])
  }
  func applicationWillTerminate(_ notification: Notification) {
    report(["kind": "owned-receiver-terminating", "pid": Int(getpid())])
  }
  func applicationDidBecomeActive(_ notification: Notification) { reportFocus("applicationDidBecomeActive") }
  func applicationDidResignActive(_ notification: Notification) { reportFocus("applicationDidResignActive") }
  func windowDidBecomeKey(_ notification: Notification) { reportFocus("windowDidBecomeKey") }
  func windowDidResignKey(_ notification: Notification) { reportFocus("windowDidResignKey") }
  func windowDidBecomeMain(_ notification: Notification) { reportFocus("windowDidBecomeMain") }
  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(contentRect:NSRect(x:100,y:100,width:650,height:350),styleMask:[.titled,.closable],backing:.buffered,defer:false)
    window.title = argument("--window-title") ?? "ZenX owned native button fixture"
    window.delegate = self
    let button = NSButton(title:"Native action",target:self,action:#selector(pressed(_:)))
    button.frame = NSRect(x:40,y:200,width:250,height:50)
    let field = NSTextField(string:""); field.frame = NSRect(x:40,y:130,width:350,height:40); field.setAccessibilityLabel("Native field")
    output.frame = NSRect(x:40,y:70,width:500,height:40)
    let pad = DragReceiver(frame: NSRect(x:40,y:10,width:500,height:50))
    pad.wantsLayer = true; pad.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
    pad.setAccessibilityElement(true); pad.setAccessibilityLabel("Owned drag receiver pad")
    pad.showResult = { [weak self] message in
      self?.output.stringValue = message
      self?.reportFocus("dragReceived")
    }
    window.contentView!.addSubview(pad)
    window.contentView!.addSubview(button); window.contentView!.addSubview(field); window.contentView!.addSubview(output)
    // A normal key-capable window, not an accessory overlay. The acceptance
    // launcher creates two owned apps. Neither requests self-activation; the
    // production helper must acquire the receiver from the owned distractor.
    window.makeKeyAndOrderFront(nil)
    if CommandLine.arguments.contains("--noninteractive-overlay") {
      // An owned visual rectangle above the complete drag pad, deliberately not
      // an input/accessibility recipient. No helper bypass ID is provided.
      let rectangle = window.convertToScreen(pad.convert(pad.bounds, to: nil))
      let overlay = NoninteractiveOverlay(contentRect: rectangle, styleMask: [.borderless], backing: .buffered, defer: false)
      overlay.title = "Owned noninteractive visual overlay"
      overlay.isOpaque = false
      overlay.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.15)
      overlay.level = .floating
      overlay.ignoresMouseEvents = true
      overlay.setAccessibilityElement(false)
      overlay.orderFront(nil)
      self.overlay = overlay
    }
    reportFocus("ready")
    func globalPoint(_ local: NSPoint) -> [String: Double] {
      let screenPoint = window.convertPoint(toScreen: pad.convert(local, to: nil))
      return ["x": screenPoint.x, "y": (NSScreen.screens.first?.frame.maxY ?? 0) - screenPoint.y]
    }
    let ready: [String: Any] = ["kind": "owned-receiver-ready", "pid": Int(getpid()),
      "windowTitle": window.title, "windowId": window.windowNumber,
      "bundlePath": Bundle.main.bundlePath,
      "activationPolicy": NSApp.activationPolicy().rawValue,
      "noninteractiveOverlayWindowId": overlay?.windowNumber ?? 0,
      "overlayIgnoresMouseEvents": overlay?.ignoresMouseEvents ?? false,
      "frontmostPID": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1),
      "dragStart": globalPoint(NSPoint(x: 30, y: 25)), "dragEnd": globalPoint(NSPoint(x: 170, y: 25))]
    report(ready)
  }
}
let application = NSApplication.shared
let initialPolicy = application.activationPolicy()
// Bundled apps already have regular policy. A redundant policy-switch return
// value is not the state predicate; verify the actual policy before proceeding.
var policySwitchAccepted: Bool? = nil
if initialPolicy != .regular { policySwitchAccepted = application.setActivationPolicy(.regular) }
report(["kind": "owned-receiver-policy", "pid": Int(getpid()),
  "initialPolicy": initialPolicy.rawValue, "activationPolicy": application.activationPolicy().rawValue,
  "switchAttempted": policySwitchAccepted != nil, "switchAccepted": policySwitchAccepted ?? false])
guard application.activationPolicy() == .regular else {
  report(["kind": "owned-receiver-startup-failed", "reason": "regular activation policy unavailable", "pid": Int(getpid())])
  exit(3)
}
let delegate = Delegate()
application.delegate = delegate
// Test-owned shutdown only; no PID-based termination of another application.
if let stopFile = argument("--stop-file") {
  Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    if FileManager.default.fileExists(atPath: stopFile) { application.terminate(nil) }
  }
}
// Snapshot requests are serviced on the AppKit run loop after launch, rather
// than treating the one-time ready marker as settled foreground evidence.
if let probeFile = argument("--focus-probe-file") {
  var lastToken = ""
  Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
    guard let token = try? String(contentsOfFile: probeFile, encoding: .utf8), !token.isEmpty, token != lastToken else { return }
    lastToken = token
    delegate.reportFocus("probe", token: token)
  }
}
if let probeFile = argument("--pointer-hit-probe-file") {
  var lastToken = ""
  Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
    guard let data = FileManager.default.contents(atPath: probeFile),
          let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let token = request["token"] as? String, !token.isEmpty, token != lastToken,
          let x = request["x"] as? Double, let y = request["y"] as? Double,
          x.isFinite, y.isFinite, let selected = request["selectedCGWindowId"] as? Int, selected > 0 else { return }
    lastToken = token
    delegate.reportPointerHit(token, x: x, y: y, selectedCGWindowId: selected)
  }
}
application.run()
