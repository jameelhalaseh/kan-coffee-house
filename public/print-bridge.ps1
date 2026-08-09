# ─────────────────────────────────────────────────────────────────────────────
# CashierPOS local print bridge (Windows).
#
# Lets the web app (HTTPS) print ESC/POS to a Windows-installed printer that has
# NO virtual COM port (LAN printers, generic/Chinese USB printers on port USBxxx).
# The app POSTs base64 ESC/POS bytes here; this RAW-prints them to the printer
# queue (driver does NOT reformat) so raster + drawer-kick reach the printer.
#
# Endpoints (localhost only):
#   GET  /health                  -> "ok"
#   POST /print[?printer=NAME]     body = base64 ESC/POS  -> RAW print
#                                  (no ?printer = Windows default printer)
#
# Run:  powershell -ExecutionPolicy Bypass -File print-bridge.ps1
# Auto-start: see README.md (Task Scheduler at logon).
# ─────────────────────────────────────────────────────────────────────────────

$Port = 9110

Add-Type @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool StartDocPrinter(IntPtr h, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
  public static bool Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return false;
    DOCINFO di = new DOCINFO(); di.pDocName = "CashierPOS Receipt"; di.pDataType = "RAW";
    bool ok = StartDocPrinter(h, 1, ref di);
    if (ok) { StartPagePrinter(h); int w; ok = WritePrinter(h, bytes, bytes.Length, out w);
      EndPagePrinter(h); EndDocPrinter(h); }
    ClosePrinter(h); return ok;
  }
}
"@

function Get-DefaultPrinter {
  Add-Type -AssemblyName System.Drawing
  (New-Object System.Drawing.Printing.PrinterSettings).PrinterName
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "CashierPOS print bridge listening on http://localhost:$Port"
Write-Host "Default printer: $(Get-DefaultPrinter)"

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request; $res = $ctx.Response
  $res.Headers.Add("Access-Control-Allow-Origin", "*")
  $res.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
  try {
    if ($req.HttpMethod -eq "OPTIONS") { $res.StatusCode = 204 }
    elseif ($req.Url.AbsolutePath -eq "/health") {
      $b = [Text.Encoding]::UTF8.GetBytes("ok"); $res.OutputStream.Write($b,0,$b.Length)
    }
    elseif ($req.Url.AbsolutePath -eq "/print" -and $req.HttpMethod -eq "POST") {
      $reader = New-Object IO.StreamReader($req.InputStream, $req.ContentEncoding)
      $b64 = $reader.ReadToEnd(); $reader.Close()
      $bytes = [Convert]::FromBase64String($b64)
      $printer = $req.QueryString["printer"]; if ([string]::IsNullOrWhiteSpace($printer)) { $printer = Get-DefaultPrinter }
      $ok = [RawPrinter]::Send($printer, $bytes)
      if (-not $ok) { $res.StatusCode = 500 }
      $msg = if ($ok) { "printed" } else { "print-failed" }
      $b = [Text.Encoding]::UTF8.GetBytes($msg); $res.OutputStream.Write($b,0,$b.Length)
    } else { $res.StatusCode = 404 }
  } catch {
    $res.StatusCode = 500
    $b = [Text.Encoding]::UTF8.GetBytes("error: $($_.Exception.Message)")
    try { $res.OutputStream.Write($b,0,$b.Length) } catch {}
  } finally { $res.Close() }
}
