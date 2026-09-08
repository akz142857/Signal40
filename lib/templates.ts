export type VideoTemplate = {
  id: 'signal40-editorial' | 'signal40-terminal' | 'signal40-brief';
  name: string;
  description: string;
  version: string;
  palette: {
    ink: string;
    paper: string;
    primary: string;
    secondary: string;
    blue: string;
    muted: string;
  };
};

export const VIDEO_TEMPLATES: readonly VideoTemplate[] = [
  {
    id: 'signal40-editorial',
    name: 'Editorial Signal',
    description: '深色编辑部风格，适合财报、商品与公司事件。',
    version: '1.2.0',
    palette: { ink: '#111716', paper: '#f3f5ee', primary: '#b8ef62', secondary: '#ff9e51', blue: '#71a7ff', muted: '#9ba7a3' },
  },
  {
    id: 'signal40-terminal',
    name: 'Market Terminal',
    description: '深蓝终端风格，强调价格、指标与时间序列。',
    version: '1.1.0',
    palette: { ink: '#07111f', paper: '#eef7ff', primary: '#49e3c2', secondary: '#ffb454', blue: '#63b3ff', muted: '#89a1b8' },
  },
  {
    id: 'signal40-brief',
    name: 'Executive Brief',
    description: '暖白简报风格，适合政策、宏观与解释型内容。',
    version: '1.1.0',
    palette: { ink: '#f2efe7', paper: '#18201e', primary: '#34775f', secondary: '#c4613d', blue: '#315d8f', muted: '#66716d' },
  },
] as const;

export function getVideoTemplate(id: string | null | undefined) {
  return VIDEO_TEMPLATES.find((template) => template.id === id) ?? VIDEO_TEMPLATES[0];
}
