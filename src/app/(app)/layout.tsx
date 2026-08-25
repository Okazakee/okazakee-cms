import type { Metadata } from 'next';
import { connection } from 'next/server';

// The whole app is the CMS: every route renders per-request (see AppLayout),
// so we declare it instead of letting Cache Components flag the connection()
// call as an accidental blocker during prerendering.
export const instant = false;

export const metadata: Metadata = {
  title: {
    default: 'Okazakee CMS',
    template: '%s · Okazakee CMS',
  },
  description: 'Content management for okazakee.dev',
};

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // CMS pages import Server Actions into Client Components. Force request-time
  // rendering so the route never serves stale action identifiers after
  // deploys (the whole app is the CMS; no static generation).
  await connection();

  return children;
}
