/**
 * The asset pipeline worker — `FR-9.13`, and the reason it is a process.
 *
 * ── Why this is not in `api` ────────────────────────────────────────────────
 *
 * Optimizing a large model is tens of seconds of **synchronous** CPU: parse it,
 * weld it, simplify it once per level of detail, serialise it back. The `api`
 * process runs the 20 Hz world tick (`NFR-7`). Run inline, this work blocks the
 * event loop and freezes everybody walking around the 3D world — the upload is
 * not slow, the world stutters, and nobody connects the two.
 *
 * A worker *thread* would free the event loop and would still be wrong: it
 * shares an address space, so an out-of-memory kill while decompressing a large
 * model takes the whole process with it — and an OOM in `api` drops every
 * WebSocket connection at once. So it is a separate process in its own
 * container, which is exactly the arrangement ADR 0009 anticipated when it chose
 * pg-boss and said "the worker arrives with phase 9".
 *
 * ── Untrusted input is parsed only here ─────────────────────────────────────
 *
 * `NFR-33`. An uploaded GLB is somebody else's bytes handed to a parsing
 * library. This process holds no sockets, no sessions and no world; the worst a
 * malicious file can do is kill a container that restarts.
 *
 * ── What it does not do ─────────────────────────────────────────────────────
 *
 * No Draco, no meshopt compression. Both would shrink the output further and
 * both need a **decoder configured on the client** — `GLTFLoader` supports
 * neither by default, and the phase notes name that as sharp edge nº1: the
 * pipeline's own output silently failing to load. What is here instead is
 * lossless cleanup plus real simplification, which needs nothing on the client
 * and cannot fail that way.
 */

import { Buffer } from 'node:buffer';
import PgBoss from 'pg-boss';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { NodeIO, type Document } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { cloneDocument, dedup, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { Client as PgClient } from 'pg';
import {
  ASSET_LOD_RATIOS,
  ASSET_MAX_BYTES,
  ASSET_MAX_TRIANGLES,
  ASSET_MAX_TEXTURE_PX,
  type AssetLodDto,
} from '@hubitat/protocol';

const ASSET_OPTIMIZE_JOB = 'asset.optimize';

interface AssetOptimizeJob {
  assetId: string;
  spaceId: string;
  storageKey: string;
  kind: string;
}

/**
 * Configuration, read the same way `api` reads it.
 *
 * Duplicated rather than imported: this process must not depend on the api's
 * Nest module graph to know a hostname, and the four things it needs are four
 * environment variables. The shared package it *does* depend on is
 * `@hubitat/protocol`, which is where the limits live — so the ceiling this
 * enforces and the ceiling the api advertises cannot drift.
 */
const config = {
  postgres: {
    host: env('POSTGRES_HOST', 'localhost'),
    port: Number(env('POSTGRES_PORT', '5432')),
    user: env('POSTGRES_USER', 'hubitat'),
    password: env('POSTGRES_PASSWORD', ''),
    database: env('POSTGRES_DB', 'hubitat'),
  },
  minio: {
    endpoint: env('MINIO_ENDPOINT', ''),
    port: Number(env('MINIO_PORT', '9000')),
    useSsl: env('MINIO_USE_SSL', 'false') === 'true',
    accessKey: env('MINIO_ROOT_USER', env('MINIO_ACCESS_KEY', '')),
    secretKey: env('MINIO_ROOT_PASSWORD', env('MINIO_SECRET_KEY', '')),
    bucket: env('MINIO_BUCKET', 'hubitat-assets'),
  },
};

function env(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

function log(message: string): void {
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

// ─────────────────────────────────────────────────────────────────────────────

const storage = new S3Client({
  region: 'us-east-1',
  endpoint: `${config.minio.useSsl ? 'https' : 'http'}://${config.minio.endpoint}:${config.minio.port}`,
  forcePathStyle: true,
  credentials: { accessKeyId: config.minio.accessKey, secretAccessKey: config.minio.secretKey },
});

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);

/**
 * The database, as a plain client rather than through TypeORM.
 *
 * This process writes four columns on one table. Pulling in an ORM, its entity
 * metadata and its decorators to do that would be a second description of a
 * schema the api already owns — and a second thing to keep in step with a
 * migration it does not run.
 */
const db = new PgClient(config.postgres);

async function main(): Promise<void> {
  if (!config.minio.endpoint) {
    log('MINIO_ENDPOINT is unset — there is nothing to optimize. Exiting.');
    return;
  }

  await db.connect();

  const boss = new PgBoss({ ...config.postgres, schema: 'pgboss' });
  boss.on('error', (error) => log(`pg-boss error: ${error.message}`));
  await boss.start();
  await boss.createQueue(ASSET_OPTIMIZE_JOB);

  // One job at a time. The work is CPU-bound and this container has one of them
  // to spare; running two in parallel would make each take twice as long and
  // double the peak memory, which is the resource that actually fails.
  await boss.work<AssetOptimizeJob>(
    ASSET_OPTIMIZE_JOB,
    { batchSize: 1, pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) return;
      await handle(job.data);
    },
  );

  log(`Ready — waiting for "${ASSET_OPTIMIZE_JOB}" jobs.`);

  const shutdown = async (): Promise<void> => {
    log('Shutting down.');
    await boss.stop({ graceful: true }).catch(() => undefined);
    await db.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

/**
 * One asset, from `processing` to `ready` or `rejected`.
 *
 * A rejection is **terminal and specific** (`FR-9.12`). It is not retried,
 * because a malformed model fails the same way every time, and a queue that kept
 * re-parsing it would spend the afternoon proving that. What *is* retried — by
 * pg-boss, by throwing — is a transient failure: storage briefly unreachable.
 * The two are distinguished by which path this function takes.
 */
async function handle(job: AssetOptimizeJob): Promise<void> {
  log(`optimizing ${job.assetId}`);
  await setStatus(job.assetId, 'processing', null);

  let original: Buffer;
  try {
    original = await download(job.storageKey);
  } catch (error) {
    // Transient. Throwing hands it back to the queue, which will try again.
    throw new Error(`could not read ${job.storageKey}: ${(error as Error).message}`);
  }

  if (original.byteLength > ASSET_MAX_BYTES) {
    await reject(
      job.assetId,
      `That file is ${(original.byteLength / 1048576).toFixed(1)} MB. The limit is ` +
        `${(ASSET_MAX_BYTES / 1048576).toFixed(0)} MB.`,
    );
    return;
  }

  let document;
  try {
    // The one place untrusted bytes meet a parser. See the header.
    document = await io.readBinary(new Uint8Array(original));
  } catch (error) {
    await reject(
      job.assetId,
      `That file is not a valid glTF binary (.glb). ${(error as Error).message}`,
    );
    return;
  }

  const triangles = countTriangles(document);
  if (triangles === 0) {
    await reject(job.assetId, 'That model contains no geometry.');
    return;
  }
  if (triangles > ASSET_MAX_TRIANGLES) {
    await reject(
      job.assetId,
      `That model has ${triangles.toLocaleString('en-GB')} triangles. The limit is ` +
        `${ASSET_MAX_TRIANGLES.toLocaleString('en-GB')} — simplify it in your modelling tool ` +
        `first, or it will not render acceptably for participants.`,
    );
    return;
  }

  const oversized = oversizedTexture(document);
  if (oversized) {
    await reject(
      job.assetId,
      `A texture in that model is ${oversized}px. The limit is ${ASSET_MAX_TEXTURE_PX}px — a ` +
        `larger one is GPU memory every participant pays for.`,
    );
    return;
  }

  // Lossless cleanup, applied to the original before anything is simplified. It
  // shrinks the file for free and it is what makes `simplify` work at all: the
  // simplifier needs welded, indexed geometry, and an exported mesh usually has
  // neither.
  try {
    await document.transform(dedup(), prune(), weld());
  } catch (error) {
    await reject(job.assetId, `That model could not be processed: ${(error as Error).message}`);
    return;
  }

  await MeshoptSimplifier.ready;

  const lods: AssetLodDto[] = [];
  for (const [index, ratio] of ASSET_LOD_RATIOS.entries()) {
    // The ladder includes the original as `1.0`. Simplifying to it would write a
    // second copy of the file under a name that promised to be smaller.
    if (ratio >= 1) continue;
    try {
      // Cloned per level, because `transform` mutates: simplifying in place
      // would make each level a simplification of the previous one, and the
      // ratios would compound into something nobody asked for.
      const clone = cloneDocument(document);
      await clone.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01 }));

      const bytes = Buffer.from(await io.writeBinary(clone));
      const key = lodKey(job.storageKey, index + 1);
      await upload(key, bytes, 'model/gltf-binary');

      lods.push({
        level: index + 1,
        ratio,
        triangles: countTriangles(clone),
        bytes: bytes.byteLength,
        url: `${config.minio.bucket}/${key}`,
      });
    } catch (error) {
      // A level that cannot be produced is not a reason to reject the asset —
      // the original is perfectly usable, and `FR-9.13` is about performance
      // rather than about correctness. Logged, and the level is skipped.
      log(`LOD ${index + 1} for ${job.assetId} failed: ${(error as Error).message}`);
    }
  }

  // The cleaned original replaces what was uploaded. It is byte-identical in
  // what it renders and smaller, and leaving the un-welded version in place
  // would mean every participant downloads the bigger one forever.
  const cleaned = Buffer.from(await io.writeBinary(document));
  if (cleaned.byteLength < original.byteLength) {
    await upload(job.storageKey, cleaned, 'model/gltf-binary');
  }

  await db.query(
    `UPDATE "assets"
        SET "status" = 'ready', "error" = NULL, "triangles" = $2, "bytes" = $3, "lods" = $4::jsonb
      WHERE "id" = $1`,
    [
      job.assetId,
      triangles,
      Math.min(cleaned.byteLength, original.byteLength),
      JSON.stringify(lods),
    ],
  );

  log(
    `${job.assetId} ready — ${triangles.toLocaleString('en-GB')} triangles, ` +
      `${lods.length} level(s) of detail, ` +
      `${(Math.min(cleaned.byteLength, original.byteLength) / 1024).toFixed(0)} KB`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function lodKey(storageKey: string, level: number): string {
  const dot = storageKey.lastIndexOf('.');
  return dot > 0
    ? `${storageKey.slice(0, dot)}.lod${level}${storageKey.slice(dot)}`
    : `${storageKey}.lod${level}`;
}

function countTriangles(document: Document): number {
  let total = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      const position = primitive.getAttribute('POSITION');
      const count = indices ? indices.getCount() : (position?.getCount() ?? 0);
      total += Math.floor(count / 3);
    }
  }
  return total;
}

/** The largest texture dimension in the document, or null when every texture is
 *  within the limit. Returned as the number so the message can name it. */
function oversizedTexture(document: Document): number | null {
  let worst = 0;
  for (const texture of document.getRoot().listTextures()) {
    const size = texture.getSize();
    if (!size) continue;
    worst = Math.max(worst, size[0], size[1]);
  }
  return worst > ASSET_MAX_TEXTURE_PX ? worst : null;
}

async function download(key: string): Promise<Buffer> {
  const response = await storage.send(
    new GetObjectCommand({ Bucket: config.minio.bucket, Key: key }),
  );
  const chunks: Buffer[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function upload(key: string, body: Buffer, contentType: string): Promise<void> {
  await storage.send(
    new PutObjectCommand({
      Bucket: config.minio.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

async function setStatus(assetId: string, status: string, error: string | null): Promise<void> {
  await db.query(`UPDATE "assets" SET "status" = $2, "error" = $3 WHERE "id" = $1`, [
    assetId,
    status,
    error,
  ]);
}

/** `FR-9.12` — terminal, and always with the specific reason. "Invalid file" is
 *  not something somebody can act on. */
async function reject(assetId: string, reason: string): Promise<void> {
  await setStatus(assetId, 'rejected', reason);
  log(`${assetId} rejected: ${reason}`);
}

main().catch((error: Error) => {
  console.error(`[worker] fatal: ${error.message}`);
  process.exit(1);
});
