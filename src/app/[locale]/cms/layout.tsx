import { connection } from 'next/server';
import type { Metadata } from 'next';

export function generateStaticParams() {
  return [{ locale: 'en' }, { locale: 'it' }];
}

export const metadata: Metadata = {
  title: 'CMS - Dashboard',
  description: 'Content Management System Dashboard',
};

export default async function CMSLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // CMS pages import Server Actions into Client Components. Force request-time
  // rendering so the route never serves stale action identifiers after deploys.
  await connection();

  return children;
}
