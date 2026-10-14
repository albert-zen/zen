import path from "node:path";

/** Fixed, app-bundled source. Requests travel through stdin, never source interpolation.
 * PrintWindow is isolated in a killable process: it can block inside the target app.
 * The helper has no output path and cannot leave a screenshot after cancellation.
 */
export const WINDOWS_BACKGROUND_CAPTURE_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
try {
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System.Drawing,System -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class ZenXBackgroundCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

  public sealed class Result {
    public string hwnd, windowTitle, pngBase64;
    public int processId, width, height;
    public string method = "strict-background-printwindow";
  }

  static string Text(IntPtr hwnd, bool title) {
    var text = new StringBuilder(4097);
    if (title) GetWindowText(hwnd, text, text.Capacity); else GetClassName(hwnd, text, text.Capacity);
    return text.ToString();
  }

  static string Identity(IntPtr hwnd, int expectedPid, string title, out Rect rect) {
    uint pid;
    uint thread = GetWindowThreadProcessId(hwnd, out pid);
    if (!IsWindow(hwnd) || thread == 0 || pid != expectedPid || Text(hwnd, true) != title)
      throw new InvalidOperationException("capture_target_changed: inspect the exact window again");
    if (IsIconic(hwnd)) throw new InvalidOperationException("capture_minimized: background capture does not restore windows");
    if (!IsWindowVisible(hwnd)) throw new InvalidOperationException("capture_hidden: no background frame is available");
    int cloaked;
    if (DwmGetWindowAttribute(hwnd, 14, out cloaked, sizeof(int)) != 0 || cloaked != 0)
      throw new InvalidOperationException("capture_unavailable: window is cloaked or its visibility cannot be verified");
    uint affinity;
    // Some foreign windows deny this query. A reported exclusion is always honored;
    // native capture failure/blank detection below handles unavailable pixels.
    if (GetWindowDisplayAffinity(hwnd, out affinity) && affinity != 0)
      throw new InvalidOperationException("capture_protected: target excludes capture");
    if (!GetWindowRect(hwnd, out rect)) throw new InvalidOperationException("capture_unavailable: window bounds unavailable");
    using (var process = Process.GetProcessById(expectedPid)) {
      return pid + ":" + process.StartTime.ToUniversalTime().Ticks + ":" + thread + ":" + Text(hwnd, false) + ":" + title + ":" + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom;
    }
  }

  public static Result Capture(string rawHwnd, int expectedPid, string title) {
    var previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
    if (previousDpi == IntPtr.Zero) throw new InvalidOperationException("capture_unavailable: physical-pixel DPI context is unavailable");
    try { return CapturePhysical(rawHwnd, expectedPid, title); }
    finally { SetThreadDpiAwarenessContext(previousDpi); }
  }

  static Result CapturePhysical(string rawHwnd, int expectedPid, string title) {
    var hwnd = new IntPtr(long.Parse(rawHwnd, System.Globalization.CultureInfo.InvariantCulture));
    Rect rect;
    string identity = Identity(hwnd, expectedPid, title, out rect);
    int width = checked(rect.Right - rect.Left), height = checked(rect.Bottom - rect.Top);
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192 || (long)width * height > 16000000)
      throw new InvalidOperationException("capture_unavailable: invalid or oversized window bounds");
    Rect client;
    var origin = new Point();
    if (!GetClientRect(hwnd, out client) || !ClientToScreen(hwnd, ref origin))
      throw new InvalidOperationException("capture_unavailable: client bounds unavailable");
    int left = Math.Max(0, origin.X - rect.Left), top = Math.Max(0, origin.Y - rect.Top);
    int right = Math.Min(width, left + client.Right - client.Left), bottom = Math.Min(height, top + client.Bottom - client.Top);
    if (right <= left || bottom <= top) throw new InvalidOperationException("capture_unavailable: empty client bounds");
    using (var bitmap = RenderFrame(hwnd, width, height, Color.Magenta)) {
      Rect after;
      if (Identity(hwnd, expectedPid, title, out after) != identity)
        throw new InvalidOperationException("capture_target_changed: window identity or geometry changed during capture");
      // Treat empty/untouched frames as unverified, never activate to obtain pixels.
      // This is an image-validity check, not the mechanism that prevents takeover.
      var locked = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      bool black = true, hasSentinel = false;
      try {
        var row = new byte[width * 4];
        for (int y = top; y < bottom; y++) {
          Marshal.Copy(IntPtr.Add(locked.Scan0, y * locked.Stride), row, 0, row.Length);
          for (int x = left * 4; x < right * 4; x += 4) {
            black &= row[x] == 0 && row[x+1] == 0 && row[x+2] == 0;
            hasSentinel |= row[x] == 255 && row[x+1] == 0 && row[x+2] == 255;
          }
        }
      } finally { bitmap.UnlockBits(locked); }
      if (black) throw new InvalidOperationException("capture_blank: no verifiable background frame; foreground fallback is disabled");
      if (hasSentinel) {
        // A real image may contain magenta. Confirm only those ambiguous pixels
        // against a second differently initialized frame, not whole-frame equality.
        // Other animations/caret changes do not invalidate the first frame.
        if (Identity(hwnd, expectedPid, title, out after) != identity)
          throw new InvalidOperationException("capture_target_changed: window changed before sentinel confirmation");
        using (var confirmation = RenderFrame(hwnd, width, height, Color.Cyan)) {
          if (Identity(hwnd, expectedPid, title, out after) != identity)
            throw new InvalidOperationException("capture_target_changed: window changed during sentinel confirmation");
          ConfirmSentinelPixels(bitmap, confirmation, left, top, right, bottom);
        }
      }
      // GDI does not promise alpha; encode opaque RGB without changing geometry.
      using (var opaque = bitmap.Clone(new Rectangle(0, 0, width, height), PixelFormat.Format24bppRgb))
      using (var stream = new MemoryStream()) {
        opaque.Save(stream, ImageFormat.Png);
        if (stream.Length > 4 * 1024 * 1024) throw new InvalidOperationException("capture_oversized: PNG exceeds 4 MiB");
        return new Result { hwnd=rawHwnd, processId=expectedPid, windowTitle=title, width=width, height=height, pngBase64=Convert.ToBase64String(stream.ToArray()) };
      }
    }
  }
  static Bitmap RenderFrame(IntPtr hwnd, int width, int height, Color sentinel) {
    var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
    try {
      using (var graphics = Graphics.FromImage(bitmap)) {
        graphics.Clear(sentinel);
        IntPtr dc = graphics.GetHdc();
        try {
          if (!PrintWindow(hwnd, dc, 2)) throw new InvalidOperationException("capture_unavailable: PrintWindow failed; foreground fallback is disabled");
        } finally { graphics.ReleaseHdc(dc); }
      }
      return bitmap;
    } catch { bitmap.Dispose(); throw; }
  }

  static void ConfirmSentinelPixels(Bitmap first, Bitmap second, int left, int top, int right, int bottom) {
    var area = new Rectangle(0, 0, first.Width, first.Height);
    var original = first.LockBits(area, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      var confirmed = second.LockBits(area, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      try {
        var before = new byte[first.Width * 4];
        var after = new byte[first.Width * 4];
        for (int y=top; y<bottom; y++) {
          Marshal.Copy(IntPtr.Add(original.Scan0, y * original.Stride), before, 0, before.Length);
          Marshal.Copy(IntPtr.Add(confirmed.Scan0, y * confirmed.Stride), after, 0, after.Length);
          for (int x=left*4; x<right*4; x+=4) {
            if (before[x]==255 && before[x+1]==0 && before[x+2]==255 &&
                !(after[x]==255 && after[x+1]==0 && after[x+2]==255))
              throw new InvalidOperationException("capture_unrendered: pixels were not drawn or changed during background confirmation");
          }
        }
      } finally { second.UnlockBits(confirmed); }
    } finally { first.UnlockBits(original); }
  }

}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = [ZenXBackgroundCapture]::Capture([string]$request.hwnd, [int]$request.pid, [string]$request.title)
[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
`;

export function windowsBackgroundCaptureCommand(): {
  executable: string;
  args: string[];
} {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  if (!path.win32.isAbsolute(systemRoot))
    throw new Error("Windows system directory must be an absolute path");
  return {
    executable: path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_BACKGROUND_CAPTURE_SCRIPT, "utf16le").toString(
        "base64",
      ),
    ],
  };
}
