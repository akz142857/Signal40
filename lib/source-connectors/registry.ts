import type { SourceAdapterName } from '../source-adapters.ts';

export type ConnectorPlatform = 'rss' | 'http_json' | 'web_page' | 'wechat' | 'xiaohongshu';

export type ConnectorDescriptor = {
  id: string;
  version: string;
  platform: ConnectorPlatform;
  adapter: SourceAdapterName;
  label: string;
  availability: 'available' | 'blocked';
  unavailableReason?: string;
  authMode: 'public-confirmation' | 'public-or-secret' | 'secret' | 'account-login' | 'none';
  requiredCapability: string;
  /** Worker 与连接器作业之间的整数协议门禁；产品版本不参与租约授权。 */
  capabilityProtocolVersion: number;
  minimumIntervalMinutes: number;
  supports: {
    test: boolean;
    backfill: boolean;
    pagination: boolean;
    edits: boolean;
    deletions: boolean;
    metrics: boolean;
  };
};

const CONNECTORS: readonly ConnectorDescriptor[] = [
  {
    id: 'rss-v1', version: '1', platform: 'rss', adapter: 'rss', label: 'RSS / Atom',
    availability: 'available', authMode: 'public-confirmation', requiredCapability: 'source:rss',
    capabilityProtocolVersion: 1,
    minimumIntervalMinutes: 15,
    supports: { test: true, backfill: true, pagination: false, edits: true, deletions: false, metrics: false },
  },
  {
    id: 'http-json-v1', version: '1', platform: 'http_json', adapter: 'http', label: 'HTTP JSON API',
    availability: 'available', authMode: 'public-or-secret', requiredCapability: 'source:http-json',
    capabilityProtocolVersion: 2,
    minimumIntervalMinutes: 15,
    supports: { test: true, backfill: true, pagination: true, edits: true, deletions: true, metrics: false },
  },
  {
    id: 'web-page-v1', version: '1', platform: 'web_page', adapter: 'http', label: '网页 / 热榜',
    availability: 'blocked', unavailableReason: '尚未完成授权站点模板与隔离浏览器验收。',
    authMode: 'none', requiredCapability: 'source:browser', minimumIntervalMinutes: 30,
    capabilityProtocolVersion: 1,
    supports: { test: false, backfill: false, pagination: false, edits: false, deletions: false, metrics: false },
  },
  {
    id: 'wechat-v1', version: '1', platform: 'wechat', adapter: 'opencli', label: '微信公众号',
    availability: 'blocked', unavailableReason: '平台可行性 Spike 尚未确认稳定、获授权的账号订阅路径。',
    authMode: 'account-login', requiredCapability: 'source:wechat', minimumIntervalMinutes: 30,
    capabilityProtocolVersion: 1,
    supports: { test: false, backfill: false, pagination: false, edits: false, deletions: false, metrics: false },
  },
  {
    id: 'xiaohongshu-v1', version: '1', platform: 'xiaohongshu', adapter: 'opencli', label: '小红书账号',
    availability: 'blocked', unavailableReason: '尚无已确认的官方、企业授权或合规供应商连接路径。',
    authMode: 'account-login', requiredCapability: 'source:xiaohongshu', minimumIntervalMinutes: 60,
    capabilityProtocolVersion: 1,
    supports: { test: false, backfill: false, pagination: false, edits: false, deletions: false, metrics: false },
  },
];

export function listSourceConnectors() {
  return CONNECTORS.map((connector) => ({ ...connector, supports: { ...connector.supports } }));
}

export function sourceConnectorByPlatform(platform: string) {
  return CONNECTORS.find((connector) => connector.platform === platform) ?? null;
}

export function sourceConnectorById(id: string, version?: string) {
  return CONNECTORS.find((connector) => connector.id === id && (version === undefined || connector.version === version)) ?? null;
}

export function platformForAdapter(adapter: SourceAdapterName): ConnectorPlatform {
  return adapter === 'http' ? 'http_json' : adapter === 'opencli' ? 'wechat' : 'rss';
}
