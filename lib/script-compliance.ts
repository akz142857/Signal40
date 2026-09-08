/**
 * 脚本表达合规检查。
 *
 * 这**不是**新增门禁：G4 的判定仍然是「声明全覆盖 + 当前脚本已批准」，
 * 这里只服务两件事——编辑器里的即时提示，以及自动放行 G4 的前置条件之一
 * （见 `docs/UI_AND_AUTOMATION_PLAN.md` §5.2）。人依旧可以在看过之后手工批准，
 * 自动放行则一律不碰这些表述。
 *
 * 词表只覆盖「明确构成投资建议或收益承诺」的说法。它不是内容审核，
 * 也代替不了编辑判断；宁可漏报也不要把正常的事实陈述挡下来。
 */

export type ComplianceFinding = {
  lineId: string;
  phrase: string;
  reason: string;
};

/** 明确越界的表达：荐股、收益承诺、内幕信息、仓位指令。 */
const BANNED_PHRASES: Array<{ phrase: string; reason: string }> = [
  { phrase: '推荐买入', reason: '构成个股买卖建议' },
  { phrase: '建议买入', reason: '构成个股买卖建议' },
  { phrase: '建议卖出', reason: '构成个股买卖建议' },
  { phrase: '强烈推荐', reason: '构成个股买卖建议' },
  { phrase: '闭眼买', reason: '构成个股买卖建议' },
  { phrase: '满仓', reason: '构成仓位指令' },
  { phrase: '抄底', reason: '构成择时指令' },
  { phrase: '加杠杆', reason: '构成杠杆操作建议' },
  { phrase: '保证收益', reason: '收益承诺' },
  { phrase: '稳赚', reason: '收益承诺' },
  { phrase: '包赚', reason: '收益承诺' },
  { phrase: '无风险', reason: '收益承诺' },
  { phrase: '必涨', reason: '确定性预测' },
  { phrase: '必跌', reason: '确定性预测' },
  { phrase: '一定会涨', reason: '确定性预测' },
  { phrase: '翻倍', reason: '收益暗示' },
  { phrase: '内幕消息', reason: '暗示未公开信息' },
  { phrase: '独家内幕', reason: '暗示未公开信息' },
];

export function checkScriptCompliance(script: {
  disclaimer: string;
  lines: ReadonlyArray<{ id: string; text: string; screenText?: string }>;
}) {
  const findings: ComplianceFinding[] = [];
  for (const line of script.lines) {
    const text = `${line.text} ${line.screenText ?? ''}`;
    for (const banned of BANNED_PHRASES) {
      if (text.includes(banned.phrase)) findings.push({ lineId: line.id, phrase: banned.phrase, reason: banned.reason });
    }
  }
  const disclaimer = script.disclaimer.trim();
  const disclaimerOk = disclaimer.length >= 10 && disclaimer.includes('不构成') && disclaimer.includes('投资建议');
  return {
    passed: findings.length === 0 && disclaimerOk,
    disclaimerOk,
    findings,
    reasons: [
      ...findings.map((finding) => `${finding.lineId} 含违禁表述「${finding.phrase}」（${finding.reason}）`),
      ...(disclaimerOk ? [] : ['免责声明缺失或未写明「不构成投资建议」']),
    ],
  };
}
