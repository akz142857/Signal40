import { stableHash } from './hash.ts';

export type CommittedPageManifestRow = {
  page_key: string;
  page_ordinal: number | null;
  content_hash: string | null;
  lease_epoch: number;
  final_page: number;
  status: string;
  checkpoint_after_json: unknown;
  fetched_count: number;
  accepted_count: number;
  rejected_count: number;
  duplicate_count: number;
  request_count: number;
  byte_count: number;
};

export type PageTotals = {
  fetchedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  requestCount: number;
  byteCount: number;
};

export function pageReplayDecision(
  existing: { contentHash: string | null; leaseEpoch: number } | null,
  proposed: { contentHash: string; leaseEpoch: number },
) {
  if (!existing) return 'accept' as const;
  return existing.contentHash === proposed.contentHash && existing.leaseEpoch === proposed.leaseEpoch
    ? 'replay' as const
    : 'conflict' as const;
}

export function validateNextCommittedPage(input: {
  previous: { pageOrdinal: number; finalPage: boolean } | null;
  proposedOrdinal: number;
  currentCheckpointJson: unknown;
  checkpointBeforeJson: unknown;
}) {
  if (input.previous?.finalPage) return '运行已经提交 final page，不能继续追加页面。';
  const expectedOrdinal = input.previous ? input.previous.pageOrdinal + 1 : 0;
  if (input.proposedOrdinal !== expectedOrdinal) {
    return `页面序号不连续：期待 ${expectedOrdinal}，收到 ${input.proposedOrdinal}。`;
  }
  if (stableHash(input.currentCheckpointJson ?? {}) !== stableHash(input.checkpointBeforeJson ?? {})) {
    return '页面 checkpointBeforeJson 与当前来源 checkpoint 不一致。';
  }
  return null;
}

export function validateCompletionManifest(
  pages: CommittedPageManifestRow[],
  expected: { pageCount: number; lastPageKey: string; totals: PageTotals },
): { error: string } | { lastPage: CommittedPageManifestRow; totals: PageTotals } {
  if (pages.length !== expected.pageCount) {
    return { error: `页面数量不一致：已提交 ${pages.length}，声明 ${expected.pageCount}。` };
  }
  for (let ordinal = 0; ordinal < pages.length; ordinal += 1) {
    const page = pages[ordinal];
    if (
      page.page_ordinal !== ordinal || page.status !== 'committed' ||
      !page.content_hash || page.lease_epoch < 1 ||
      Boolean(page.final_page) !== (ordinal === pages.length - 1)
    ) {
      return { error: `页面序列在 ordinal ${ordinal} 不连续、未提交、租约无效或 final 标志错误。` };
    }
  }
  const lastPage = pages.at(-1);
  if (!lastPage || lastPage.page_key !== expected.lastPageKey) {
    return { error: 'lastPageKey 与最后提交页不一致。' };
  }
  const totals = pages.reduce<PageTotals>((sum, page) => ({
    fetchedCount: sum.fetchedCount + Number(page.fetched_count),
    acceptedCount: sum.acceptedCount + Number(page.accepted_count),
    rejectedCount: sum.rejectedCount + Number(page.rejected_count),
    duplicateCount: sum.duplicateCount + Number(page.duplicate_count),
    requestCount: sum.requestCount + Number(page.request_count),
    byteCount: sum.byteCount + Number(page.byte_count),
  }), { fetchedCount: 0, acceptedCount: 0, rejectedCount: 0, duplicateCount: 0, requestCount: 0, byteCount: 0 });
  for (const key of Object.keys(totals) as Array<keyof PageTotals>) {
    if (totals[key] !== expected.totals[key]) {
      return { error: `${key} 累计值不一致：已提交 ${totals[key]}，声明 ${expected.totals[key]}。` };
    }
  }
  return { lastPage, totals };
}
