import AppKit
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
    window.contentView!.addSubview(button); window.contentView!.addSubview(field); window.contentView!.addSubview(output)
    window.orderFrontRegardless()
    print("{\"pid\":\(ProcessInfo.processInfo.processIdentifier),\"windowTitle\":\"\(window.title)\"}"); fflush(stdout)
  }
}
let delegate=Delegate(); NSApplication.shared.delegate=delegate; NSApplication.shared.run()
