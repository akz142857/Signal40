/**
 * OpenAI 嵌入接口调用。
 *
 * 单独成一个模块是为了让 Render Worker 和标定脚本用同一份调用代码——
 * 阈值是在标定脚本测出的余弦分布上定的，如果两边的请求参数（模型、输入构造、
 * 截断方式）有任何差异，那个阈值就不适用于线上算出来的向量。
 *
 * 不读 env：API key 由调用方传入。`lib/runtime.ts` 是唯一读 env 的模块。
 */

import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_INPUT_CHAR_LIMIT,
} from './embedding.ts';

const EMBEDDINGS_ENDPOINT = 'https://api.openai.com/v1/embeddings';
const REQUEST_TIMEOUT_MS = 60_000;
/** 429 和 5xx 退避重试；4xx（除 429）是请求本身有问题，重试没有意义。 */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

export class EmbeddingRequestError extends Error {
  /** 可重试：429 和 5xx。其余 4xx 是请求本身的问题，重试只会重复同一个错误。 */
  retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'EmbeddingRequestError';
    this.retryable = retryable;
  }
}

type EmbeddingResponse = {
  data?: { index: number; embedding: number[] }[];
  usage?: { total_tokens?: number };
};

/** 只取上游错误的 code 字段，绝不把响应体原样带进错误信息——里面可能回显文章正文。 */
async function errorCode(response: Response) {
  try {
    const payload = (await response.json()) as {
      error?: { code?: unknown; type?: unknown };
    };
    const code = payload.error?.code ?? payload.error?.type;
    return typeof code === 'string' ? code.slice(0, 64) : '';
  } catch {
    return '';
  }
}

async function embedBatch(apiKey: string, model: string, inputs: string[]) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]),
      );
    }
    let response: Response;
    try {
      response = await fetch(EMBEDDINGS_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, input: inputs }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = new EmbeddingRequestError(
        `嵌入请求失败：${error instanceof Error ? error.message : String(error)}`,
        true,
      );
      continue;
    }
    if (response.ok) {
      const payload = (await response.json()) as EmbeddingResponse;
      const data = payload.data ?? [];
      if (data.length !== inputs.length) {
        throw new EmbeddingRequestError(
          `嵌入结果条数与输入不符：请求 ${inputs.length} 条，返回 ${data.length} 条。`,
          false,
        );
      }
      // 按 index 归位而不是依赖返回顺序：错位的向量比缺失的向量危险得多，
      // 它不会报错，只会让所有相似度判定安静地失真。
      const vectors: number[][] = Array.from(
        { length: inputs.length },
        () => [],
      );
      for (const entry of data) {
        if (
          !Number.isInteger(entry.index) ||
          entry.index < 0 ||
          entry.index >= inputs.length
        ) {
          throw new EmbeddingRequestError(
            `嵌入结果下标越界：${entry.index}`,
            false,
          );
        }
        vectors[entry.index] = entry.embedding;
      }
      if (vectors.some((vector) => !vector?.length)) {
        throw new EmbeddingRequestError('嵌入结果存在空向量。', false);
      }
      return { vectors, tokens: payload.usage?.total_tokens ?? 0 };
    }
    // 不带上游响应体：嵌入接口的 invalid_request_error 会回显触发错误的 input 片段，
    // 那是文章正文，会顺着作业失败路径落进 jobs.last_error 和日志。
    const upstreamCode = await errorCode(response);
    const retryable = response.status === 429 || response.status >= 500;
    lastError = new EmbeddingRequestError(
      `嵌入请求返回 ${response.status}${upstreamCode ? `（${upstreamCode}）` : ''}。`,
      retryable,
    );
    if (!retryable) throw lastError;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 批量嵌入，返回与输入同序的向量。
 *
 * 空白输入不发请求、直接返回空向量：嵌入接口会拒绝空字符串，而「标题摘要都是空的
 * 文章」应该被判成「没有可用向量」，不该让整批失败。
 *
 * **一条坏数据不毒死整批**：不可重试的 4xx（输入超长、字符非法之类）会让整批失败，
 * 这时改成逐条重试，把失败隔离到那一条上，其余照常返回。没有这一层的话，
 * 一条毒数据会让包含它的每个作业都失败，而它一直排在待嵌入队列最前面，
 * 结果是全站向量停摆，直到它自己滑出回填窗口。
 */
export async function embedTexts(
  apiKey: string,
  model: string,
  texts: readonly string[],
  batchSize = EMBEDDING_BATCH_SIZE,
) {
  const vectors: number[][] = Array.from({ length: texts.length }, () => []);
  const pending: { index: number; text: string }[] = [];
  for (const [index, text] of texts.entries()) {
    const trimmed = text.trim().slice(0, EMBEDDING_INPUT_CHAR_LIMIT);
    if (trimmed) pending.push({ index, text: trimmed });
  }
  const failures: { index: number; reason: string }[] = [];
  let tokens = 0;
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    const batch = pending.slice(offset, offset + batchSize);
    try {
      const result = await embedBatch(
        apiKey,
        model,
        batch.map((entry) => entry.text),
      );
      tokens += result.tokens;
      for (const [position, entry] of batch.entries()) {
        vectors[entry.index] = result.vectors[position];
      }
      continue;
    } catch (error) {
      // 可重试的失败已经在 embedBatch 里退避重试过了；走到这里说明整批都没成功。
      // 网络/限流类向上抛（整个作业重试才有意义），数据类才逐条隔离。
      if (error instanceof EmbeddingRequestError && error.retryable) throw error;
      if (batch.length === 1) {
        failures.push({
          index: batch[0].index,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }
    for (const entry of batch) {
      try {
        const single = await embedBatch(apiKey, model, [entry.text]);
        tokens += single.tokens;
        vectors[entry.index] = single.vectors[0];
      } catch (error) {
        if (error instanceof EmbeddingRequestError && error.retryable) throw error;
        failures.push({
          index: entry.index,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { vectors, tokens, failures };
}
