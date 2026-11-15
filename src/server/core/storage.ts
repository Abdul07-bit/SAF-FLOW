import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { badRequest } from "../http/errors";
import { signFileUrl } from "./keys";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

/**
 * File storage abstraction. STORAGE_DRIVER=local writes under ./storage;
 * STORAGE_DRIVER=s3 uses any S3-compatible service (AWS S3, MinIO, R2...).
 * Files are served back through GET /api/files/<key>.
 */
interface Driver {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; contentType: string } | null>;
  remove(key: string): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

function localDriver(): Driver {
  // Serverless hosts (Vercel) have no permanent disk: files would vanish.
  if (process.env.VERCEL)
    throw new Error("File storage is not configured: set STORAGE_DRIVER=s3 (for example Supabase Storage) on Vercel.");
  const root = path.resolve(process.env.STORAGE_LOCAL_DIR || "./storage");
  const resolve = (key: string) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw badRequest("Invalid file key.");
    return full;
  };
  return {
    async put(key, body) {
      const full = resolve(key);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body);
    },
    async get(key) {
      try {
        const body = await readFile(resolve(key));
        const ext = key.split(".").pop()!.toLowerCase();
        return { body, contentType: CONTENT_TYPES[ext] ?? "application/octet-stream" };
      } catch {
        return null;
      }
    },
    async remove(key) {
      await unlink(resolve(key)).catch(() => undefined);
    },
  };
}

function s3Driver(): Driver {
  const bucket = process.env.S3_BUCKET || "saf-files";
  const clientP = import("@aws-sdk/client-s3").then((m) => ({
    m,
    client: new m.S3Client({
      region: process.env.S3_REGION || "us-east-1",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
      },
    }),
  }));
  return {
    async put(key, body, contentType) {
      const { m, client } = await clientP;
      await client.send(new m.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      const { m, client } = await clientP;
      try {
        const r = await client.send(new m.GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = await r.Body!.transformToByteArray();
        return { body, contentType: r.ContentType || "application/octet-stream" };
      } catch {
        return null;
      }
    },
    async remove(key) {
      const { m, client } = await clientP;
      await client.send(new m.DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
    },
  };
}

let driver: Driver | null = null;
export function storage(): Driver {
  driver ??= process.env.STORAGE_DRIVER === "s3" ? s3Driver() : localDriver();
  return driver;
}

/** Detects PNG / JPEG by magic bytes - the only formats the ID-card PDF can embed. */
export function sniffImage(bytes: Uint8Array): "png" | "jpg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Validates and stores an uploaded image, returning its storage key. */
export async function saveImage(tenantId: string, folder: string, file: File | null): Promise<string> {
  if (!file || typeof file === "string") throw badRequest("Please attach an image file.");
  if (file.size > MAX_IMAGE_BYTES) throw badRequest("Image must be 2 MB or smaller.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) throw badRequest("Only PNG or JPEG images are supported.");
  const clean = reencodeImage(bytes, kind);
  const key = `t/${tenantId}/${folder}/${randomUUID()}.${kind}`;
  await storage().put(key, clean, CONTENT_TYPES[kind]);
  return key;
}

/** Decoding limit: a small file can describe a huge picture ("decompression bomb"). */
const MAX_IMAGE_MEGAPIXELS = 25;

/**
 * Decodes the upload and writes a brand-new file from the pixels only. This
 * drops every metadata block (EXIF GPS location, camera serials, comments)
 * and anything appended to or hidden inside the original file.
 */
export function reencodeImage(bytes: Uint8Array, kind: "png" | "jpg"): Uint8Array {
  try {
    if (kind === "png") {
      // Width and height sit in the IHDR chunk: check them before decoding anything.
      const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const width = view.readUInt32BE(16), height = view.readUInt32BE(20);
      if (!width || !height || width * height > MAX_IMAGE_MEGAPIXELS * 1_000_000) throw new Error("dimensions");
      // Anything after the IEND chunk (a common hiding place) is cut off before decoding.
      const iend = view.lastIndexOf("IEND");
      const img = PNG.sync.read(iend > 0 ? view.subarray(0, iend + 8) : view);
      return new Uint8Array(PNG.sync.write(img, { colorType: 6 }));
    }
    const img = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: MAX_IMAGE_MEGAPIXELS, maxMemoryUsageInMB: 512 });
    return new Uint8Array(jpeg.encode({ data: img.data, width: img.width, height: img.height }, 90).data);
  } catch {
    throw badRequest(`This image could not be read. Use a normal PNG or JPEG photo up to ${MAX_IMAGE_MEGAPIXELS} megapixels.`);
  }
}

/**
 * Folders whose files are personal data (employee photos, payment receipts). Their URLs carry a
 * short-lived HMAC signature; without it /api/files refuses to serve them.
 * Business logos stay public: they appear on QR menus and customer invoices.
 */
export const PRIVATE_FOLDERS = new Set(["employees", "receipts"]);
const PHOTO_URL_TTL_SEC = 3600;

export function isPrivateKey(key: string): boolean {
  return PRIVATE_FOLDERS.has(key.split("/")[2] ?? "");
}

export function fileUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  if (!isPrivateKey(key)) return `/api/files/${key}`;
  // Expiry rounded up to the hour so the browser can cache a photo for a while,
  // while a leaked link stops working within two hours at most.
  const exp = (Math.floor(Date.now() / 1000 / PHOTO_URL_TTL_SEC) + 2) * PHOTO_URL_TTL_SEC;
  try {
    return `/api/files/${key}?exp=${exp}&sig=${signFileUrl(key, exp)}`;
  } catch {
    return null; // signing key unavailable (production without SAF_APP_SECRET): fail closed
  }
}
