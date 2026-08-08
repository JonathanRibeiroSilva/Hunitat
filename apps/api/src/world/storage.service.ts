/**
 * Object storage — MinIO, S3-compatible (ADR 0010).
 *
 * ── Bytes never pass through this process ───────────────────────────────────
 *
 * `FR-9.11` uploads are presigned `PUT`s straight to the bucket, and downloads
 * are presigned `GET`s the client follows. The api signs a URL and gets out of
 * the way, which is not a micro-optimisation: this process runs the 20 Hz world
 * tick (`NFR-7`), and buffering a 40 MB model through it would stutter the world
 * for everybody walking around in it. It is the same reasoning that puts the
 * optimization pipeline in another process entirely.
 *
 * ── Two addresses for one bucket ────────────────────────────────────────────
 *
 * Exactly the problem `LIVEKIT_PUBLIC_URL` solved one phase earlier. Under
 * Compose the api reaches MinIO at `http://minio:9000` — a name that resolves
 * only inside the Docker network — and a URL signed against it sends every
 * browser to a host it cannot look up. A presigned URL carries its host inside
 * the signature, so it cannot be rewritten afterwards: it has to be *signed*
 * against the address the browser will use.
 *
 * So there are two clients. The private one talks to the bucket (create it,
 * read objects for the pipeline); the public one exists only to sign URLs.
 *
 * ── Absence is a supported state ────────────────────────────────────────────
 *
 * With no MinIO configured, uploads are unavailable and say so — and `FR-9.15`
 * is what makes that survivable rather than crippling: the built-in asset
 * library ships in the repository, so a Map can be authored with no object
 * storage at all. The same treatment media gets when there is no SFU.
 */

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadConfig, type RuntimeConfig } from '../config/tuning.config.js';

@Injectable()
export class StorageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorageService.name);
  private readonly config: RuntimeConfig = loadConfig();

  /** Talks to the bucket. Reachable from this process. */
  private readonly internal: S3Client | null;
  /** Signs URLs for browsers. Never used to make a request — see the header. */
  private readonly external: S3Client | null;

  constructor() {
    if (!this.enabled) {
      this.internal = null;
      this.external = null;
      return;
    }

    const credentials = {
      accessKeyId: this.config.minioAccessKey,
      secretAccessKey: this.config.minioSecretKey,
    };
    const scheme = this.config.minioUseSsl ? 'https' : 'http';

    this.internal = new S3Client({
      // MinIO has no regions; the SDK insists on one, and any constant will do
      // as long as the signer and the server agree — which they do, because the
      // server ignores it.
      region: 'us-east-1',
      endpoint: `${scheme}://${this.config.minioEndpoint}:${this.config.minioPort}`,
      // Path-style, not virtual-host: `bucket.minio` is not a name Docker's DNS
      // resolves, and MinIO serves path-style by default.
      forcePathStyle: true,
      credentials,
    });

    this.external = new S3Client({
      region: 'us-east-1',
      endpoint: this.config.minioPublicUrl,
      forcePathStyle: true,
      credentials,
    });
  }

  get enabled(): boolean {
    return Boolean(
      this.config.minioEndpoint && this.config.minioAccessKey && this.config.minioSecretKey,
    );
  }

  get bucket(): string {
    return this.config.minioBucket;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.internal) {
      this.logger.warn(
        'MINIO_ENDPOINT / MINIO_ROOT_USER / MINIO_ROOT_PASSWORD are unset — asset uploads are ' +
          'disabled. The built-in asset library still works, so maps can be authored (FR-9.15).',
      );
      return;
    }

    // Created here rather than by a deployment step, because a bucket that does
    // not exist is the difference between "uploads are off" and "every upload
    // fails with a signature error nobody can read".
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.internal.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`Created bucket "${this.bucket}".`);
      } catch (error) {
        this.logger.error(
          `Could not create the "${this.bucket}" bucket: ${(error as Error).message}. ` +
            `Uploads will fail until it exists.`,
        );
        return;
      }
    }

    this.logger.log(
      `Object storage at ${this.config.minioEndpoint}:${this.config.minioPort}, bucket ` +
        `"${this.bucket}", browsers sent to ${this.config.minioPublicUrl}`,
    );
  }

  /** `FR-9.11` — where to put the bytes, and for how long the offer stands. */
  async presignUpload(
    key: string,
    contentType: string,
  ): Promise<{ url: string; headers: Record<string, string> } | null> {
    if (!this.external) return null;
    const url = await getSignedUrl(
      this.external,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: this.config.assetUrlTtlSeconds },
    );
    // Signed, so it must be sent exactly. A presigned URL with a mismatched
    // content type fails as a signature error, which is a memorable afternoon.
    return { url, headers: { 'content-type': contentType } };
  }

  /** A URL a browser can fetch. Re-issued per request rather than stored: it
   *  expires, and a stored one would be a broken link in a Map Document. */
  async presignDownload(key: string): Promise<string | null> {
    if (!this.external) return null;
    return getSignedUrl(this.external, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: this.config.assetUrlTtlSeconds,
    });
  }

  /** Whether the bytes actually arrived, and how many. The presign call trusted
   *  the client's declared size; this is what checks it. */
  async describe(key: string): Promise<{ bytes: number; contentType: string } | null> {
    if (!this.internal) return null;
    try {
      const head = await this.internal.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        bytes: Number(head.ContentLength ?? 0),
        contentType: head.ContentType ?? 'application/octet-stream',
      };
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    if (!this.internal) return;
    try {
      await this.internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      // A missing object is the ordinary case for a rejected upload that never
      // completed. Worth a line, not worth failing a delete over.
      this.logger.debug(`delete ${key}: ${(error as Error).message}`);
    }
  }
}
