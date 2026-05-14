import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_CLIPBOARD_IMAGE_BYTES = 15 * 1024 * 1024;

const SUPPORTED_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
};

export async function writeImageToClipboard(opts: {
  mediaType: string;
  dataBase64: string;
}): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("image clipboard paste is currently supported only on Windows hosts");
  }

  const ext = SUPPORTED_IMAGE_TYPES[opts.mediaType];
  if (!ext) {
    throw new Error(`unsupported clipboard image type: ${opts.mediaType}`);
  }

  const data = Buffer.from(opts.dataBase64, "base64");
  if (data.length === 0) {
    throw new Error("clipboard image was empty");
  }
  if (data.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error("clipboard image is too large");
  }

  const path = join(tmpdir(), `telepathy-clipboard-${randomUUID()}.${ext}`);
  await writeFile(path, data);
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Sta",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "& { param([string]$imagePath) $ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image = [System.Drawing.Image]::FromFile($imagePath); try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() } }",
      path,
    ], { windowsHide: true, timeout: 15_000 });
  } finally {
    await rm(path, { force: true });
  }
}
