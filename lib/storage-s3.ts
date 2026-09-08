import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type {
  MultipartUpload,
  ObjectListing,
  ObjectPutBody,
  ObjectPutOptions,
  ObjectStorage,
  StoredObject,
  StoredObjectBody,
  UploadedPart,
} from './storage.ts';

/**
 * `ObjectStorage` 的 S3 协议实现。生产用 Cloudflare R2 的 S3 兼容端点，
 * 同一份代码也能连 AWS S3 或其他 S3 兼容服务。
 *
 * S3 协议与 `ObjectStorage` 契约之间的三处落差都在这里补平：
 * 1. `ListObjectsV2` 不返回用户元数据，需要时逐个 HEAD 补齐；
 * 2. `CompleteMultipartUpload` 不返回对象大小，完成后补一次 HEAD；
 * 3. 没有内建的 SHA-256 校验和，`sha256` 返回 null，由调用方回退到 etag。
 *
 * R2 侧还有两个约束：region 必须是 `auto`，以及不接受 SDK 默认的 CRC32
 * 校验和头（见 `createS3Client`）。分片上传要求除最后一片外每片等大，
 * 应用侧固定 10 MB 分片，满足该约束。
 */

export type S3StorageOptions = {
  bucket: string;
  client: S3Client;
};

export type S3ConnectionOptions = {
  /** 自建端点或 R2 的 S3 端点；连 AWS S3 时留空。 */
  endpoint?: string;
  /** R2 只接受 `auto`；连 AWS S3 时按桶所在区设置。 */
  region?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * AWS SDK v3 从 3.729 起默认给每个请求加 CRC32 校验和头（`WHEN_SUPPORTED`），
   * R2 会因此拒绝请求。默认改成 `WHEN_REQUIRED`——只在协议要求时计算，
   * AWS S3 与其他 S3 兼容实现同样接受。
   */
  checksumMode?: 'WHEN_REQUIRED' | 'WHEN_SUPPORTED';
};

/** 按 S3 / R2 / 自建端点的差异建客户端。运行时和测试共用这一份，避免配置漂移。 */
export function createS3Client(options: S3ConnectionOptions) {
  const checksumMode = options.checksumMode ?? 'WHEN_REQUIRED';
  return new S3Client({
    region: options.region || 'auto',
    endpoint: options.endpoint,
    // 自建端点通常不支持虚拟主机风格的桶名寻址；R2 两种都支持。
    forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
    credentials: options.accessKeyId && options.secretAccessKey
      ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
      // 不给显式凭据时交给 SDK 的默认链（实例角色、~/.aws/credentials 等）。
      : undefined,
    requestChecksumCalculation: checksumMode,
    responseChecksumValidation: checksumMode,
  });
}

function normalizeEtag(etag: string | undefined) {
  return (etag ?? '').replace(/^"|"$/g, '');
}

async function headObject(client: S3Client, bucket: string, key: string) {
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return {
    size: Number(head.ContentLength ?? 0),
    etag: normalizeEtag(head.ETag),
    customMetadata: head.Metadata,
  };
}

function createMultipartHandle(client: S3Client, bucket: string, key: string, uploadId: string): MultipartUpload {
  return {
    uploadId,
    async uploadPart(partNumber, data): Promise<UploadedPart> {
      const body = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const part = await client.send(new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
      }));
      return { partNumber, etag: normalizeEtag(part.ETag) };
    },
    async complete(parts): Promise<StoredObject> {
      await client.send(new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        // S3 要求分片按 PartNumber 升序提交，R2 对顺序宽容——这里统一排好。
        MultipartUpload: {
          Parts: [...parts]
            .sort((left, right) => left.partNumber - right.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }));
      // CompleteMultipartUpload 不返回 ContentLength，补一次 HEAD 拿大小。
      const head = await headObject(client, bucket, key);
      return { key, size: head.size, etag: head.etag, sha256: null };
    },
    async abort() {
      await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
    },
  };
}

export function createS3Storage(options: S3StorageOptions): ObjectStorage {
  const { bucket, client } = options;
  return {
    async get(key): Promise<StoredObjectBody | null> {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!object.Body) return null;
        return { body: object.Body.transformToWebStream() };
      } catch (error) {
        // 对象不存在按 null 返回，和 R2 的 get 语义一致；其他错误照常抛。
        if (error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound')) return null;
        throw error;
      }
    },
    async put(key, data: ObjectPutBody, putOptions?: ObjectPutOptions) {
      const body = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body as Uint8Array | string,
        ContentType: putOptions?.contentType,
        Metadata: putOptions?.customMetadata,
      }));
    },
    async delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      if (!list.length) return;
      if (list.length === 1) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: list[0] }));
        return;
      }
      // DeleteObjects 单次上限 1000 个键。
      for (let index = 0; index < list.length; index += 1000) {
        await client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: list.slice(index, index + 1000).map((key) => ({ Key: key })) },
        }));
      }
    },
    async list({ prefix, cursor, limit, includeMetadata }): Promise<ObjectListing> {
      const listed = await client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: cursor,
        MaxKeys: limit,
      }));
      const keys = (listed.Contents ?? []).map((object) => String(object.Key));
      const objects = includeMetadata
        // ListObjectsV2 不带用户元数据，只能逐个 HEAD。生产环境更省的做法是
        // 用桶的生命周期规则做过期，而不是靠应用扫描。
        ? await Promise.all(keys.map(async (key) => ({ key, customMetadata: (await headObject(client, bucket, key)).customMetadata })))
        : keys.map((key) => ({ key }));
      return {
        objects,
        cursor: listed.IsTruncated ? listed.NextContinuationToken : undefined,
        truncated: Boolean(listed.IsTruncated),
      };
    },
    async createMultipartUpload(key, putOptions) {
      const created = await client.send(new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: putOptions?.contentType,
        Metadata: putOptions?.customMetadata,
      }));
      if (!created.UploadId) throw new Error('S3 未返回 UploadId。');
      return createMultipartHandle(client, bucket, key, created.UploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      return createMultipartHandle(client, bucket, key, uploadId);
    },
  };
}
