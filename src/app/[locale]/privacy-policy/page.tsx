import { notFound } from 'next/navigation';
import MarkdownRenderer from '@/components/layout/MarkdownRenderer';
import { getPrivacyPolicy } from '@/utils/getData';

export function generateStaticParams() {
  return [{ locale: 'en' }, { locale: 'it' }];
}

const titles: Record<string, string> = {
  en: 'Privacy Policy',
  it: 'Informativa sulla Privacy',
};

const descriptions: Record<string, string> = {
  en: 'Privacy Policy for the Okazakee website',
  it: 'Informativa sulla privacy per il sito Okazakee',
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const title = titles[locale] ?? titles.en;
  const description = descriptions[locale] ?? descriptions.en;

  return {
    title: `${title} | Okazakee`,
    description,
  };
}

export default async function PrivacyPolicyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const privacyPolicy = await getPrivacyPolicy(locale);

  if (!privacyPolicy) {
    notFound();
  }

  return (
    <main className="flex flex-col items-center justify-center max-w-(--breakpoint-2xl) mx-auto px-5 py-16">
      <div className="w-full max-w-4xl">
        <h1 className="text-4xl font-bold mb-8 text-center">
          {titles[locale] ?? titles.en}
        </h1>
        <div className="prose dark:prose-invert max-w-none">
          <MarkdownRenderer markdown={privacyPolicy} />
        </div>
      </div>
    </main>
  );
}
