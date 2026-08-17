import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import CopyLinkButton from '../common/CopyButton';

export default async function Footer({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: 'footer' });

  return (
    <footer className="border-t border-darktext dark:border-lighttext">
      <div className="py-4 lg:flex-row flex-col-reverse flex items-center lg:justify-between justify-center relative mx-auto max-w-(--breakpoint-2xl)">
        <div className="text-xs xs:text-base sm:text-base md:my-0 w-fit lg:ml-5">
          {t('left')}{' '}
          <Link href="https://github.com/Okazakee" className="text-main">
            Okazakee
          </Link>{' '}
          |{' '}
          <Link
            href="https://github.com/Okazakee/okazakee-ws"
            className="hover:text-main text-xs xs:stext-sm md:text-base text-left transition-colors duration-0"
          >
            {t('source')}
          </Link>
        </div>

        <CopyLinkButton
          className="lg:absolute lg:left-1/2 lg:transform-gpu lg:-translate-x-1/2"
          copyValue="02863310815"
          buttonTitle={t('buttonTitle')}
        >
          {t('middle')} - 02863310815
        </CopyLinkButton>

        <div className="text-xs xs:text-base sm:text-base md:my-0 w-fit lg:mr-5 flex items-center gap-3">
          <Link
            href={`/${locale}/cms`}
            prefetch={false}
            className="hover:text-main text-xs xs:text-sm md:text-base text-right transition-colors duration-0"
          >
            CMS
          </Link>
          <span className="text-gray-500 dark:text-gray-400">|</span>
          <Link
            href={`/${locale}/privacy-policy`}
            className="hover:text-main text-xs xs:text-sm md:text-base text-right transition-colors duration-0"
          >
            {t('privacyPolicy')}
          </Link>
        </div>
      </div>
    </footer>
  );
}
