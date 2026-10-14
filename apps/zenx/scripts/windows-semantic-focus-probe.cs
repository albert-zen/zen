// Test-only direct COM client. Never loaded by the production provider.
// COM interface order/GUIDs: Microsoft's Windows SDK UIAutomationClient.h.
// AutoSetFocus: https://learn.microsoft.com/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-get_autosetfocus
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ProbeAutomation {
  // Uncalled prefix slots preserve the SDK ABI without importing a UIA wrapper.
  void ReservedCompareElements();
  void ReservedCompareRuntimeIds();
  void ReservedGetRootElement();
  [PreserveSig] int ElementFromHandle(IntPtr hwnd, out ProbeElement element);
}
[ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ProbeElement {
  void ReservedSetFocus();
  [PreserveSig] int GetRuntimeId([MarshalAs(UnmanagedType.SafeArray, SafeArraySubType=VarEnum.VT_I4)] out int[] id);
  void ReservedFindFirst();
  void ReservedFindAll();
  void ReservedFindFirstBuildCache();
  void ReservedFindAllBuildCache();
  void ReservedBuildUpdatedCache();
  [PreserveSig] int GetCurrentPropertyValue(int property, [MarshalAs(UnmanagedType.Struct)] out object value);
  void ReservedGetCurrentPropertyValueEx();
  void ReservedGetCachedPropertyValue();
  void ReservedGetCachedPropertyValueEx();
  void ReservedGetCurrentPatternAs();
  void ReservedGetCachedPatternAs();
  [PreserveSig] int GetCurrentPattern(int pattern, [MarshalAs(UnmanagedType.IUnknown)] out object value);
}
[ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ProbeValuePattern {
  [PreserveSig] int SetValue([MarshalAs(UnmanagedType.BStr)] string value);
  [PreserveSig] int GetCurrentValue([MarshalAs(UnmanagedType.BStr)] out string value);
  [PreserveSig] int GetCurrentIsReadOnly(out int value);
}
[ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ProbeInvokePattern { [PreserveSig] int Invoke(); }

public sealed class ZenXSemanticProbeResult {
  public string action;
  public bool defaultAutoSetFocus, configuredAutoSetFocus;
  public string className, frameworkId, providerDescription;
  public int[] runtimeId;
  public bool completeValue, guardUnchanged;
}
public static class ZenXSemanticFocusProbe {
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr hwnd, StringBuilder value, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint message, IntPtr wParam, StringBuilder value, uint flags, uint timeout, out UIntPtr result);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetBool(IntPtr self, out int value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PutBool(IntPtr self, int value);

  public static string ClassName(long handle) {
    var result = new StringBuilder(256);
    if (GetClassNameW(new IntPtr(handle), result, result.Capacity)==0) throw new InvalidOperationException("Unavailable fixture HWND class");
    return result.ToString();
  }
  static void CheckIdentity(long window, long control, int pid, long started, string expectedClass) {
    uint windowPid, controlPid;
    var root = new IntPtr(window); var child = new IntPtr(control);
    if (!IsWindow(root) || !IsWindow(child) ||
        GetWindowThreadProcessId(root, out windowPid)==0 ||
        GetWindowThreadProcessId(child, out controlPid)==0 ||
        windowPid != pid || controlPid != pid || GetAncestor(child, 2) != root ||
        ClassName(control) != expectedClass)
      throw new InvalidOperationException("Fixture HWND identity mismatch");
    using (var process=Process.GetProcessById(pid)) {
      if (process.HasExited || process.StartTime.ToUniversalTime().Ticks != started)
        throw new InvalidOperationException("Fixture process lifetime changed");
    }
  }
  static string ReadText(long handle) {
    var text = new StringBuilder(4096); UIntPtr length;
    if (SendMessageTimeoutW(new IntPtr(handle), 0x000D, new IntPtr(text.Capacity), text, 0x23, 1000, out length)==IntPtr.Zero)
      throw new InvalidOperationException("Fixture text read failed or timed out; no fallback");
    return text.ToString();
  }
  static object Property(ProbeElement element, int property) {
    object value; Marshal.ThrowExceptionForHR(element.GetCurrentPropertyValue(property, out value)); return value;
  }
  public static ZenXSemanticProbeResult Run(long window, long control, long guardWindow, long guardControl, int pid, long started, string expectedClass, string guardClass, string action, bool suppressAutoFocus, string value, string phasePath) {
    if (action != "set-value" && action != "invoke") throw new ArgumentException("Unsupported probe action");
    CheckIdentity(window, control, pid, started, expectedClass);
    CheckIdentity(guardWindow, guardControl, pid, started, guardClass);
    var guardText=ReadText(guardControl);
    object automationObject=null, patternObject=null; ProbeElement element=null;
    IntPtr unknown=IntPtr.Zero, automation2=IntPtr.Zero;
    try {
      // Match WinApp 0.3.1's exact COM coclass, independent of its session/selector wrapper.
      automationObject=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9")));
      var automation=(ProbeAutomation)automationObject;
      unknown=Marshal.GetIUnknownForObject(automationObject);
      var iid=new Guid("34723aff-0c9d-49d0-9896-7ab52df8cd8a");
      Marshal.ThrowExceptionForHR(Marshal.QueryInterface(unknown, ref iid, out automation2));
      // IUnknown slots 0..2 + IUIAutomation slots 3..57; IUIAutomation2 adds get/put here.
      var vtable=Marshal.ReadIntPtr(automation2);
      var get=(GetBool)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtable, 58*IntPtr.Size), typeof(GetBool));
      var put=(PutBool)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtable, 59*IntPtr.Size), typeof(PutBool));
      int original, configured;
      Marshal.ThrowExceptionForHR(get(automation2, out original));
      if (suppressAutoFocus) Marshal.ThrowExceptionForHR(put(automation2, 0));
      Marshal.ThrowExceptionForHR(get(automation2, out configured));
      if (suppressAutoFocus && configured != 0) throw new InvalidOperationException("AutoSetFocus=false was not applied");
      Marshal.ThrowExceptionForHR(automation.ElementFromHandle(new IntPtr(control), out element));
      int[] runtimeId; Marshal.ThrowExceptionForHR(element.GetRuntimeId(out runtimeId));
      if (runtimeId == null || runtimeId.Length==0 || Convert.ToInt32(Property(element, 30002)) != pid || Convert.ToInt64(Property(element, 30020)) != control)
        throw new InvalidOperationException("UIA identity did not match exact fixture control");
      var result=new ZenXSemanticProbeResult {
        action=action, defaultAutoSetFocus=original!=0, configuredAutoSetFocus=configured!=0,
        className=Convert.ToString(Property(element, 30012)), frameworkId=Convert.ToString(Property(element, 30024)),
        providerDescription=Convert.ToString(Property(element, 30107)), runtimeId=runtimeId
      };
      if (!Convert.ToBoolean(Property(element, action=="set-value" ? 30043 : 30031)))
        throw new InvalidOperationException("Fixture does not support requested pattern");
      Marshal.ThrowExceptionForHR(element.GetCurrentPattern(action=="set-value" ? 10002 : 10000, out patternObject));
      if (patternObject==null) throw new InvalidOperationException("Fixture does not support requested pattern");
      int[] currentId; Marshal.ThrowExceptionForHR(element.GetRuntimeId(out currentId));
      CheckIdentity(window, control, pid, started, expectedClass);
      if (!runtimeId.SequenceEqual(currentId)) throw new InvalidOperationException("Fixture UIA runtime identity changed");
      File.WriteAllText(phasePath, "direct-uia-" + (suppressAutoFocus ? "no-focus-" : "default-") + action);
      if (action=="set-value") {
        var pattern=(ProbeValuePattern)patternObject;
        int readOnly; Marshal.ThrowExceptionForHR(pattern.GetCurrentIsReadOnly(out readOnly));
        if (readOnly != 0) throw new InvalidOperationException("Fixture value is read-only");
        Marshal.ThrowExceptionForHR(pattern.SetValue(value));
        string actual; Marshal.ThrowExceptionForHR(pattern.GetCurrentValue(out actual));
        result.completeValue=actual==value;
        if (!result.completeValue) throw new InvalidOperationException("Incomplete direct-UIA value");
      } else {
        Marshal.ThrowExceptionForHR(((ProbeInvokePattern)patternObject).Invoke());
      }
      CheckIdentity(window, control, pid, started, expectedClass);
      CheckIdentity(guardWindow, guardControl, pid, started, guardClass);
      result.guardUnchanged=guardText==ReadText(guardControl);
      if (!result.guardUnchanged) throw new InvalidOperationException("Sibling guard text changed");
      return result;
    } finally {
      if (patternObject!=null && Marshal.IsComObject(patternObject)) Marshal.ReleaseComObject(patternObject);
      if (element!=null && Marshal.IsComObject(element)) Marshal.ReleaseComObject(element);
      if (automation2!=IntPtr.Zero) Marshal.Release(automation2);
      if (unknown!=IntPtr.Zero) Marshal.Release(unknown);
      if (automationObject!=null && Marshal.IsComObject(automationObject)) Marshal.ReleaseComObject(automationObject);
    }
  }
}
