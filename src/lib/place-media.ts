import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const SAFE_KEY = /^[0-9a-f-]{36}\.webp$/i;

function mediaRoot() {
  const root = path.resolve(process.env.PLACE_MEDIA_ROOT || path.join(process.cwd(), ".private", "place-media"));
  if (root.split(path.sep).some((part) => part.toLowerCase() === "public")) throw new ApiError(500, "Private photo storage cannot be under public");
  return root;
}

function safePath(root: string, key: string) {
  if (!SAFE_KEY.test(key)) throw new ApiError(404, "Photo not found");
  const target = path.resolve(root, key);
  if (!target.startsWith(root + path.sep)) throw new ApiError(404, "Photo not found");
  return target;
}

export async function savePlacePhoto(args: { cafeId: string; branchId: string; actorId: string; assetId?: string; observationId?: string; input: Buffer }) {
  const hasAsset = !!args.assetId, hasObservation = !!args.observationId;
  if (hasAsset === hasObservation) throw new ApiError(400, "Attach a photo to exactly one asset or observation");
  if (!args.input.length || args.input.length > MAX_BYTES) throw new ApiError(400, "Photo must be between 1 byte and 5 MiB");
  if (hasAsset) {
    const asset = await db.placeAsset.findFirst({ where: { id: args.assetId, cafeId: args.cafeId, branchId: args.branchId, isActive: true }, select: { id: true } });
    if (!asset) throw new ApiError(400, "Photo asset is not active in this branch");
  } else {
    const observation = await db.placeObservation.findFirst({ where: { id: args.observationId, receipt: { cafeId: args.cafeId, branchId: args.branchId } }, select: { id: true } });
    if (!observation) throw new ApiError(400, "Photo observation is outside this branch");
  }
  let metadata: sharp.Metadata;
  try { metadata = await sharp(args.input, { limitInputPixels: MAX_PIXELS }).metadata(); }
  catch { throw new ApiError(400, "Photo data is invalid"); }
  if (!["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new ApiError(400, "Upload a JPEG, PNG or WebP photo");
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) throw new ApiError(400, "Photo dimensions exceed 25 megapixels");
  let encoded: { data: Buffer; info: sharp.OutputInfo };
  try { encoded = await sharp(args.input, { limitInputPixels: MAX_PIXELS }).rotate().webp({ quality: 82, effort: 4 }).toBuffer({ resolveWithObject: true }); }
  catch { throw new ApiError(400, "Photo could not be decoded"); }

  const root = mediaRoot(), key = crypto.randomUUID() + ".webp", target = safePath(root, key);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(target, encoded.data, { flag: "wx" });
  try {
    const photo = await db.placePhoto.create({ data: { cafeId: args.cafeId, branchId: args.branchId, assetId: args.assetId, observationId: args.observationId, uploaderId: args.actorId, storageKey: key, mime: "image/webp", byteCount: encoded.data.length, width: encoded.info.width, height: encoded.info.height }, select: { id: true, mime: true, byteCount: true, width: true, height: true, createdAt: true } });
    return { photo };
  } catch (error) {
    const resolved = safePath(root, key);
    if (resolved === target) await fs.unlink(target).catch(() => undefined);
    throw error;
  }
}

export async function readPlacePhoto(args: { photoId: string; actor: SessionUser }) {
  if (!args.actor.cafeId) throw new ApiError(404, "Photo not found");
  const photo = await db.placePhoto.findFirst({ where: { id: args.photoId, cafeId: args.actor.cafeId, ...(args.actor.branchId ? { branchId: args.actor.branchId } : {}) }, select: { storageKey: true, mime: true } });
  if (!photo) throw new ApiError(404, "Photo not found");
  const root = mediaRoot(), target = safePath(root, photo.storageKey);
  try { return { bytes: await fs.readFile(target), mime: photo.mime }; }
  catch { throw new ApiError(404, "Photo file is unavailable"); }
}
