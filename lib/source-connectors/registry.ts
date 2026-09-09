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
  authMode: 'public-confirmation' | 'none';
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
    availability: 'available', authMode: 'public-confirmation', requiredCapability: 'source:http-json',
    capabilityProtocolVersion: 2,
    minimumIntervalMinutes: 15,
    supports: { test: true, backfill: true, pagination: true, edits: true, deletions: true, metrics: false },
  },
  {
    id: 'web-page-v1', version: '1', platform: 'web_page', adapter: 'web', label: '公开网页 / 热榜',
    availability: 'available',
    authMode: 'public-confirmation', requiredCapability: 'source:web', minimumIntervalMinutes: 30,
    capabilityProtocolVersion: 1,
    supports: { test: true, backfill: true, pagination: false, edits: true, deletions: false, metrics: false },
  },
  {
    id: 'wechat-feed-v1', version: '1', platform: 'wechat', adapter: 'rss', label: '微信公众号公开 Feed',
    availability: 'available',
    authMode: 'public-confirmation', requiredCapability: 'source:rss', minimumIntervalMinutes: 30,
    capabilityProtocolVersion: 1,
    supports: { test: true, backfill: true, pagination: false, edits: true, deletions: false, metrics: false },
  },
  {
    id: 'xiaohongshu-feed-v1', version: '1', platform: 'xiaohongshu', adapter: 'rss', label: '小红书公开 Feed',
    availability: 'available',
    authMode: 'public-confirmation', requiredCapability: 'source:rss', minimumIntervalMinutes: 60,
    capabilityProtocolVersion: 1,
    supports: { test: true, backfill: true, pagination: false, edits: true, deletions: false, metrics: false },
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
  return adapter === 'http' ? 'http_json' : adapter === 'web' ? 'web_page' : 'rss';
}
