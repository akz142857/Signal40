/**
 * 媒体对象存储接口（成片、音轨、封面、发布包、来源原文留存）。
 *
 * 形状按 R2 与 S3 的公共子集设计，选项名做了拉平：R2 的
 * `{ httpMetadata: { contentType }, customMetadata }` 与 S3 的
 * `{ ContentType, Metadata }` 在这里统一成 `{ contentType, customMetadata }`，
 * 由各自的适配器映射。调用方不该看到任何一方的私有字段。
 */

export type ObjectPutBody = ArrayBuffer | ArrayBufferView | ReadableStream | string;

export type ObjectPutOptions = {
  contentType?: string;
  customMetadata?: Record<string, string>;
};

/** 写入完成后的对象描述。 */
export type StoredObject = {
  key: string;
  size: number;
  etag: string;
  /**
   * 内容 SHA-256（十六进制）。后端不提供校验和时为 null，
   * 调用方回退到 `etag`——资产表的 `sha256` 列允许这两种来源。
   */
  sha256: string | null;
};

/** 读取句柄；只暴露流，避免调用方把整个成片读进内存。 */
export type StoredObjectBody = { body: ReadableStream };

export type ListedObject = {
  key: string;
  customMetadata?: Record<string, string>;
};

export type ObjectListing = {
  objects: ListedObject[];
  cursor?: string;
  truncated: boolean;
};

export type UploadedPart = { partNumber: number; etag: string };

/** 分片上传句柄。`uploadId` 会落进 `asset_upload_sessions`，用于跨请求续传。 */
export interface MultipartUpload {
  readonly uploadId: string;
  uploadPart(partNumber: number, data: ArrayBuffer | ArrayBufferView): Promise<UploadedPart>;
  complete(parts: UploadedPart[]): Promise<StoredObject>;
  abort(): Promise<void>;
}

export interface ObjectStorage {
  get(key: string): Promise<StoredObjectBody | null>;
  put(key: string, data: ObjectPutBody, options?: ObjectPutOptions): Promise<void>;
  /** 支持批量删除；实现需要在后端不支持批量时自行拆分。 */
  delete(keys: string | string[]): Promise<void>;
  /**
   * 列举对象。`includeMetadata` 默认关闭：R2 的 list 能顺带返回 customMetadata，
   * 而 S3 的 ListObjectsV2 不返回用户元数据，实现只能逐个 HEAD 补齐。
   * 只有确实要读元数据的调用方才打开它。
   */
  list(options: { prefix: string; cursor?: string; limit?: number; includeMetadata?: boolean }): Promise<ObjectListing>;
  createMultipartUpload(key: string, options?: ObjectPutOptions): Promise<MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;
}
