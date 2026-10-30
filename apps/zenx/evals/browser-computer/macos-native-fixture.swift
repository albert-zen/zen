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
final class Delegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var pressCount = 0
  let output = NSTextField(labelWithString: "Not pressed")
  @objc func pressed(_ sender: NSButton) { pressCount += 1; output.stringValue = "PASS native button pressed \(pressCount)" }
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    window = NSWindow(contentRect:NSRect(x:100,y:100,width:650,height:350),styleMask:[.titled,.closable],backing:.buffered,defer:false)
    window.title = "ZenX owned native button fixture"
    let button = NSButton(title:"Native action",target:self,action:#selector(pressed(_:)))
    button.frame = NSRect(x:40,y:200,width:250,height:50)
    let field = NSTextField(string:""); field.frame = NSRect(x:40,y:130,width:350,height:40); field.setAccessibilityLabel("Native field")
    output.frame = NSRect(x:40,y:70,width:500,height:40)
    let pad = DragReceiver(frame: NSRect(x:40,y:10,width:500,height:50))
    pad.wantsLayer = true; pad.layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
    pad.setAccessibilityElement(true); pad.setAccessibilityLabel("Owned drag receiver pad")
    pad.showResult = { [weak self] message in self?.output.stringValue = message }
    window.contentView!.addSubview(pad)
    window.contentView!.addSubview(button); window.contentView!.addSubview(field); window.contentView!.addSubview(output)
    window.orderFrontRegardless()
    func globalPoint(_ local: NSPoint) -> [String: Double] {
      let screenPoint = window.convertPoint(toScreen: pad.convert(local, to: nil))
      return ["x": screenPoint.x, "y": (NSScreen.screens.first?.frame.maxY ?? 0) - screenPoint.y]
    }
    let ready: [String: Any] = ["kind": "owned-receiver-ready", "pid": Int(getpid()),
      "windowTitle": window.title, "windowId": window.windowNumber,
      "dragStart": globalPoint(NSPoint(x: 30, y: 25)), "dragEnd": globalPoint(NSPoint(x: 170, y: 25))]
    if let data = try? JSONSerialization.data(withJSONObject: ready, options: [.sortedKeys]) {
      FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
  }
}
let delegate=Delegate(); NSApplication.shared.delegate=delegate; NSApplication.shared.run()
