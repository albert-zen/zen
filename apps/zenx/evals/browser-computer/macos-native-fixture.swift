import AppKit

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
    if let data = try? JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys]) {
      FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
    if samples > 0 { showResult?("PASS native drag received \(samples) samples and release") }
    start = nil
  }
}
final class Delegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  var window: NSWindow!
  var pressCount = 0
  let output = NSTextField(labelWithString: "Not pressed")
  @objc func pressed(_ sender: NSButton) { pressCount += 1; output.stringValue = "PASS native button pressed \(pressCount)" }
  func reportFocus(_ event: String) {
    guard let window else { return }
    let state: [String: Any] = ["kind": "owned-focus-state", "event": event,
      "pid": Int(getpid()), "windowId": window.windowNumber,
      "isActive": NSApp.isActive, "isKeyWindow": window.isKeyWindow,
      "isMainWindow": window.isMainWindow, "canBecomeKey": window.canBecomeKey,
      "activationPolicy": NSApp.activationPolicy().rawValue,
      "frontmostPID": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)]
    if let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) {
      FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
  }
  func applicationDidBecomeActive(_ notification: Notification) { reportFocus("applicationDidBecomeActive") }
  func applicationDidResignActive(_ notification: Notification) { reportFocus("applicationDidResignActive") }
  func windowDidBecomeKey(_ notification: Notification) { reportFocus("windowDidBecomeKey") }
  func windowDidResignKey(_ notification: Notification) { reportFocus("windowDidResignKey") }
  func windowDidBecomeMain(_ notification: Notification) { reportFocus("windowDidBecomeMain") }
  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(contentRect:NSRect(x:100,y:100,width:650,height:350),styleMask:[.titled,.closable],backing:.buffered,defer:false)
    window.title = "ZenX owned native button fixture"
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
    // launcher uses LaunchServices in the background; only the production
    // helper requests foreground activation (never this receiver).
    window.makeKeyAndOrderFront(nil)
    reportFocus("ready")
    func globalPoint(_ local: NSPoint) -> [String: Double] {
      let screenPoint = window.convertPoint(toScreen: pad.convert(local, to: nil))
      return ["x": screenPoint.x, "y": (NSScreen.screens.first?.frame.maxY ?? 0) - screenPoint.y]
    }
    let ready: [String: Any] = ["kind": "owned-receiver-ready", "pid": Int(getpid()),
      "windowTitle": window.title, "windowId": window.windowNumber,
      "bundlePath": Bundle.main.bundlePath,
      "activationPolicy": NSApp.activationPolicy().rawValue,
      "frontmostPID": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1),
      "dragStart": globalPoint(NSPoint(x: 30, y: 25)), "dragEnd": globalPoint(NSPoint(x: 170, y: 25))]
    if let data = try? JSONSerialization.data(withJSONObject: ready, options: [.sortedKeys]) {
      FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
  }
}
let delegate = Delegate()
let application = NSApplication.shared
// Configure before the launch lifecycle. An unbundled accessory process shown
// with orderFrontRegardless is not a normal foreground application's lifecycle.
guard application.setActivationPolicy(.regular) else { exit(3) }
application.delegate = delegate
// Test-owned shutdown only; no PID-based termination of another application.
if let index = CommandLine.arguments.firstIndex(of: "--stop-file"), index + 1 < CommandLine.arguments.count {
  let stopFile = CommandLine.arguments[index + 1]
  Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    if FileManager.default.fileExists(atPath: stopFile) { application.terminate(nil) }
  }
}
application.run()
