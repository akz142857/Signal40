import type { Metadata } from 'next';
import { AppBar } from '@/components/page-shell';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Signal 40 · 选题雷达',
  description: '从多来源信号发现、聚类并核验值得制作成 40 秒视频的选题。',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // AppBar 挂在这里而不是各页面：全站导航、品牌和当前身份必须逐页一致。
  return <html lang="zh-CN"><body className={`${geistSans.variable} ${geistMono.variable} antialiased`}><AppBar />{children}</body></html>;
}
