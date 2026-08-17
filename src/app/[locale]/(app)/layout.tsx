import { connection } from 'next/server';

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
