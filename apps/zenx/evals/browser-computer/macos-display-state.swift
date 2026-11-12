import CoreGraphics
import Foundation
let info = CGSessionCopyCurrentDictionary() as? [String: Any]
let locked = info?["CGSSessionScreenIsLocked"] as? Bool
let onConsole = info?[kCGSessionOnConsoleKey as String] as? Bool
let value: [String:Any] = [
  "displayAsleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0,
  "lockKeyPresent": info?["CGSSessionScreenIsLocked"] != nil,
  "screenLocked": locked as Any? ?? NSNull(),
  "onConsole": onConsole as Any? ?? NSNull()
]
print(String(data:try! JSONSerialization.data(withJSONObject:value),encoding:.utf8)!)
