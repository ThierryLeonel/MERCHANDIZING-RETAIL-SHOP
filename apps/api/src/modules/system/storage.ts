import { Injectable } from "@nestjs/common";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../../config";

/** Storage adapter. Local driver keeps files outside the web root; swap for S3-compatible private object storage in production. */
export interface StorageAdapter { put(buf: Buffer, ext: string): Promise<string>; get(key: string): Promise<Buffer> }

@Injectable()
export class LocalStorageAdapter implements StorageAdapter {
  private root = resolve(config.storageDir);
  async put(buf: Buffer, ext: string) {
    const key = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${ext}`;
    await mkdir(join(this.root, key.split("/")[0]), { recursive: true });
    await writeFile(join(this.root, key), buf, { mode: 0o600 });
    return key;
  }
  async get(key: string) {
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root)) throw new Error("invalid key");
    return readFile(p);
  }
}

/** Magic-byte sniffing: the declared MIME type is not trusted. */
export function sniff(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (buf.length > 12 && buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (buf.length > 4 && buf.subarray(0, 4).toString() === "%PDF") return { mime: "application/pdf", ext: "pdf" };
  return null;
}
