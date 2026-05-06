// `telepathy install-shortcut` — create a Windows Start-menu shortcut
// for `telepathy app` that the user can pin to taskbar. Uninstall via
// `--uninstall`. POSIX systems get a clear "not supported" message; we
// don't try to fake it with .desktop / .app bundles.
//
// Why we shortcut directly to electron.exe (NOT `node cli.js app`):
//   1. Skips the Node CLI process entirely — no console-window flash.
//   2. The pinned process is electron.exe, so Windows' taskbar grouping
//      via AppUserModelID stays consistent (electron's main.cjs sets
//      `app.setName("telepathy")`, but the AppUserModelID is what the
//      shell uses to dedupe pinned items).
//   3. Falls back gracefully when the repo moves: install creates a
//      shortcut keyed to the resolved electron.exe path AT INSTALL TIME.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

export type InstallShortcutOptions = {
  uninstall?: boolean;
};

// AppUserModelID — Windows uses this to group taskbar buttons and
// associate pinned shortcuts with running windows. Match what
// electron/main.cjs sets via app.setName so taskbar grouping works.
const APP_USER_MODEL_ID = "telepathy";

export async function runInstallShortcut(opts: InstallShortcutOptions): Promise<void> {
  if (process.platform !== "win32") {
    process.stderr.write(chalk.yellow(
      "telepathy install-shortcut: only supported on Windows.\n" +
      "On macOS/Linux, drag the binary or create a desktop entry manually.\n",
    ));
    process.exit(2);
  }

  // Repo root: this file lives at <repo>/dist/commands/install-shortcut.js
  // after build (or src/commands/install-shortcut.ts during dev). Walk
  // up to find the repo root containing electron/ + node_modules/.
  const here = fileURLToPath(import.meta.url);
  const repoRoot = findRepoRoot(here);
  if (!repoRoot) {
    process.stderr.write(chalk.red("telepathy install-shortcut: could not locate repo root from " + here + "\n"));
    process.exit(1);
  }

  const electronExe = join(repoRoot, "node_modules", "electron", "dist", "electron.exe");
  const mainCjs = join(repoRoot, "electron", "main.cjs");
  const iconIco = join(repoRoot, "assets", "icon.ico");
  if (!existsSync(electronExe)) {
    process.stderr.write(chalk.red(`telepathy install-shortcut: electron not found at ${electronExe}\n`));
    process.stderr.write(chalk.dim("Run `npm install` in the telepathy repo first.\n"));
    process.exit(1);
  }
  if (!existsSync(mainCjs)) {
    process.stderr.write(chalk.red(`telepathy install-shortcut: ${mainCjs} missing\n`));
    process.exit(1);
  }
  // Use the bundled telepathy icon when present; fall back to electron's
  // default if the icon hasn't been generated (assets/icon.ico is
  // produced by `python scripts/generate-icon.py`).
  const iconLocation = existsSync(iconIco) ? iconIco : electronExe;

  const startMenuDir = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs");
  const lnkPath = join(startMenuDir, "telepathy.lnk");

  if (opts.uninstall) {
    runPowerShell(`Remove-Item -LiteralPath "${lnkPath}" -ErrorAction SilentlyContinue; if (Test-Path "${lnkPath}") { exit 1 }`);
    process.stdout.write(chalk.green("✔ removed ") + lnkPath + "\n");
    process.stdout.write(chalk.dim("Unpin from taskbar manually if it's still pinned (right-click → Unpin from taskbar).\n"));
    return;
  }

  // Build the shortcut via WScript.Shell COM. Setting AppUserModelID
  // (so taskbar pin groups with the running window) requires the
  // IShellLink PropertyStore — done via a tiny inline C# helper because
  // PowerShell can't set property-store fields directly.
  //
  // Two PowerShell scripts: (1) create the .lnk (must succeed),
  // (2) tag with AppUserModelID (best-effort; warn-but-continue on
  // failure because Windows still pins+launches without it, just with
  // less-perfect taskbar grouping).
  const psCreate = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut("${escapePs(lnkPath)}")
$lnk.TargetPath = "${escapePs(electronExe)}"
$lnk.Arguments = '"${escapePs(mainCjs)}"'
$lnk.WorkingDirectory = "${escapePs(repoRoot)}"
$lnk.IconLocation = "${escapePs(iconLocation)},0"
$lnk.Description = 'telepathy LAN terminal-share wall'
$lnk.WindowStyle = 1
$lnk.Save()
`;
  const psSetAppId = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
interface IPropertyStore {
    int GetCount(out uint cProps);
    int GetAt(uint iProp, out PropertyKey pkey);
    int GetValue(ref PropertyKey key, out PropVariant pv);
    int SetValue(ref PropertyKey key, ref PropVariant pv);
    int Commit();
}
[StructLayout(LayoutKind.Sequential)]
public struct PropertyKey { public Guid fmtid; public uint pid; }
[StructLayout(LayoutKind.Explicit)]
public struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pwszVal;
}
public static class ShellHelper {
    // STGM_READWRITE = 2 — required so persist.Save() below succeeds.
    const int STGM_READWRITE = 2;
    [DllImport("ole32.dll")] static extern int CoCreateInstance(ref Guid clsid, IntPtr unk, int ctx, ref Guid iid, out IntPtr obj);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant pv);
    public static void SetAppId(string lnkPath, string appId) {
        var clsid_ShellLink = new Guid("00021401-0000-0000-C000-000000000046");
        var iid_IShellLinkW = new Guid("000214F9-0000-0000-C000-000000000046");
        var iid_IPropertyStore = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
        IntPtr unk;
        Marshal.ThrowExceptionForHR(CoCreateInstance(ref clsid_ShellLink, IntPtr.Zero, 1, ref iid_IShellLinkW, out unk));
        var persist = (System.Runtime.InteropServices.ComTypes.IPersistFile)Marshal.GetObjectForIUnknown(unk);
        persist.Load(lnkPath, STGM_READWRITE);
        IntPtr storePtr;
        Marshal.ThrowExceptionForHR(Marshal.QueryInterface(unk, ref iid_IPropertyStore, out storePtr));
        var store = (IPropertyStore)Marshal.GetObjectForIUnknown(storePtr);
        var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
        var pv = new PropVariant { vt = 31, pwszVal = Marshal.StringToCoTaskMemUni(appId) };
        Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref pv));
        Marshal.ThrowExceptionForHR(store.Commit());
        persist.Save(lnkPath, true);
        PropVariantClear(ref pv);
        Marshal.ReleaseComObject(persist);
        Marshal.ReleaseComObject(store);
        Marshal.Release(unk);
        Marshal.Release(storePtr);
    }
}
"@
[ShellHelper]::SetAppId("${escapePs(lnkPath)}", "${APP_USER_MODEL_ID}")
`;

  try {
    runPowerShell(psCreate);
  } catch (err) {
    process.stderr.write(chalk.red("telepathy install-shortcut: shortcut creation failed:\n"));
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(1);
  }
  // AppId tagging is best-effort — the .lnk works without it.
  try {
    runPowerShell(psSetAppId);
  } catch {
    process.stderr.write(chalk.yellow(
      "Note: could not set AppUserModelID (taskbar grouping). The shortcut still works.\n",
    ));
  }

  process.stdout.write(chalk.green("✔ created ") + lnkPath + "\n");
  process.stdout.write(chalk.dim("Open the Start menu, search 'telepathy', right-click the result → Pin to taskbar.\n"));
  process.stdout.write(chalk.dim("Uninstall:  telepathy install-shortcut --uninstall\n"));
}

function findRepoRoot(start: string): string | undefined {
  let dir = dirname(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "electron", "main.cjs"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

function escapePs(s: string): string {
  // Inside a PowerShell double-quoted string, ` is the escape char.
  // Also escape $ and " to be safe — paths normally won't contain these.
  return s.replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, '`"');
}

function runPowerShell(script: string): void {
  execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdio: ["ignore", "inherit", "inherit"], windowsHide: true },
  );
}
