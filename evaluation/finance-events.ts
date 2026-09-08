import type { ArticleInput } from '../lib/domain.ts';

export type FinanceEvaluationCase = {
  id: string;
  category: 'earnings' | 'commodity' | 'macro' | 'company' | 'rumor';
  description: string;
  articles: ArticleInput[];
  expectedGate: boolean;
};

const categoryTerms = {
  earnings: '财报营收利润',
  commodity: '铜价期货库存',
  macro: '宏观利率通胀',
  company: '公司公告出货',
  rumor: '市场传闻芯片',
} as const;

/**
 * 100-case deterministic regression corpus. These are synthetic contract tests,
 * not a reviewer-labelled accuracy gold set and must never be reported as one.
 */
export const financeEvaluationCases: FinanceEvaluationCase[] = Object.entries(categoryTerms).flatMap(
  ([category, terms], categoryIndex) => Array.from({ length: 20 }, (_, index) => {
    const id = `${category}-${String(index + 1).padStart(2, '0')}`;
    const expectedGate = category !== 'rumor' && index % 5 !== 4;
    const publishedAt = new Date(Date.UTC(2026, 8, 8, 1, index)).toISOString();
    const sources: ArticleInput[] = expectedGate
      ? [
          { source: `primary-${categoryIndex}`, sourceType: category === 'commodity' ? 'market' : category === 'earnings' ? 'filing' : 'company', title: `${terms} ${id} 数值上升${index + 1}%`, summary: `${terms} 原始材料`, url: `https://primary.example.com/${id}`, publishedAt },
          { source: `media-${categoryIndex}`, sourceType: 'media', title: `${terms} ${id} 数值上升${index + 1}%`, summary: `${terms} 独立报道`, url: `https://media.example.com/${id}`, publishedAt },
        ]
      : [
          { source: `social-${categoryIndex}-a`, sourceType: 'social', title: `${terms} ${id} 数值上升${index + 1}%`, summary: `${terms} 未证实讨论`, url: `https://social-a.example.com/${id}`, publishedAt },
          { source: `social-${categoryIndex}-b`, sourceType: 'social', title: `${terms} ${id} 数值上升${index + 1}%`, summary: `${terms} 转述`, url: `https://social-b.example.com/${id}`, publishedAt },
        ];
    return { id, category: category as FinanceEvaluationCase['category'], description: `${terms}门禁回归场景 ${index + 1}`, articles: sources, expectedGate };
  }),
);
