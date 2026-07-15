import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ContextRef } from "@agent-pane/shared";

const UPLOADS = path.join(os.homedir(), ".agent-pane", "uploads");

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
};

export function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

export function isImagePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".svg",
    ".heic",
    ".avif",
  ].includes(ext);
}

/** macOS screenshot / paste temp dirs that vanish quickly */
export function isEphemeralPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/");
  return (
    /\/TemporaryItems\//i.test(p) ||
    /\/screencaptureui_/i.test(p) ||
    /\/var\/folders\/[^/]+\/[^/]+\/T\//i.test(p) ||
    /NSIRD_screencapture/i.test(p)
  );
}

/**
 * Copy into ~/.agent-pane/uploads so chat history + agent keep a stable path
 * (macOS screenshot temps disappear; binary Read also fails on raw PNG paths).
 */
export function persistLocalFile(absPath: string): string {
  const src = path.resolve(absPath);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return absPath;
  // Already under our uploads — keep
  if (src.startsWith(UPLOADS + path.sep) || src === UPLOADS) return src;

  fs.mkdirSync(UPLOADS, { recursive: true });
  const base =
    path
      .basename(src)
      .replace(/[^\w.\-()+ ]+/g, "_")
      .slice(0, 120) || "file.bin";
  const dest = path.join(UPLOADS, `${Date.now().toString(36)}-${base}`);
  fs.copyFileSync(src, dest);
  return dest;
}

export function stabilizeAttachment(ref: ContextRef): ContextRef {
  if (ref.kind === "folder") return ref;
  const p = ref.path;
  if (!p) return ref;
  if (isImagePath(p) || isEphemeralPath(p)) {
    return { ...ref, path: persistLocalFile(p) };
  }
  return ref;
}

export function stabilizeAttachments(
  refs: ContextRef[] | undefined
): ContextRef[] | undefined {
  if (!refs?.length) return refs;
  return refs.map(stabilizeAttachment);
}
