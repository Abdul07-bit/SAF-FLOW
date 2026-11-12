import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { badRequest } from "../http/errors";

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
  const key = `t/${tenantId}/${folder}/${randomUUID()}.${kind}`;
  await storage().put(key, bytes, CONTENT_TYPES[kind]);
  return key;
}

export function fileUrl(key: string | null | undefined): string | null {
  return key ? `/api/files/${key}` : null;
}
