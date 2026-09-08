/**
 * 测试与冒烟脚本用的确定性文章夹具。
 *
 * 这份数据**只用于测试**，不参与任何生产路径：
 * 曾经它挂在 lib/ 下并被首页与选题接口当成兜底数据，导致全新部署也会显示
 * 三条看起来像真的财经选题。对一个以证据完整性为前提的系统，
 * 库里分不清真假的数据比没有数据危险得多。
 */

import type { ArticleInput } from '../../lib/domain.ts';

function ago(now: Date, minutes: number) {
  return new Date(now.valueOf() - minutes * 60_000).toISOString();
}

export function sampleArticles(now = new Date()): ArticleInput[] {
  return [
    { source: '财经早餐', sourceType: 'social', author: '财经早餐', title: 'DRAM 价格再涨，存储厂商利润弹性有多大？', summary: 'DRAM 报价继续上行，市场关注供需与利润率变化。', url: 'https://example.com/finance-breakfast/dram', publishedAt: ago(now, 18) },
    { source: '财联社', sourceType: 'media', title: '存储芯片涨价延续，DRAM 现货价格快速上升', summary: '多家渠道确认 DRAM 价格上涨，供给仍然偏紧。', url: 'https://example.com/cls/dram-price', publishedAt: ago(now, 34) },
    { source: '半导体观察', sourceType: 'media', title: 'DRAM 涨价周期：库存、供需与厂商利润', summary: '存储库存下降，价格变化正在传导至利润端。', url: 'https://example.com/semicon/dram-cycle', publishedAt: ago(now, 52) },
    { source: 'Micron FY2026 Q3', sourceType: 'filing', author: 'Micron', title: 'Micron 季度财报：DRAM 收入与毛利率继续改善', summary: '财报披露 DRAM 收入、价格与毛利率变化。', url: 'https://example.com/filings/micron-q3', publishedAt: ago(now, 80) },
    { source: 'LME', sourceType: 'market', title: 'LME 铜价突破关键区间', summary: '铜期货价格升至阶段高位。', url: 'https://example.com/market/lme-copper', publishedAt: ago(now, 26) },
    { source: '证券时报', sourceType: 'media', title: '铜价上行，制造业成本曲线承压', summary: '铜价与供需预期推动产业链成本变化。', url: 'https://example.com/media/copper-cost', publishedAt: ago(now, 57) },
    { source: '样本科技公司', sourceType: 'company', title: '季度财报：毛利率达到 84.84%', summary: '公司披露收入结构与 84.84% 毛利率来源。', url: 'https://example.com/company/earnings', publishedAt: ago(now, 110) },
    { source: '数据财经号', sourceType: 'social', title: '84.84% 毛利率背后，收入结构发生了什么？', summary: '高毛利业务占比上升成为市场关注点。', url: 'https://example.com/social/margin', publishedAt: ago(now, 41) },
  ];
}
