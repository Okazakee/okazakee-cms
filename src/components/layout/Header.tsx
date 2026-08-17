import logo from '@public/logo.svg';
import Link from 'next/link';
import NavMenu from './NavMenu';

export default function Header({ locale }: { locale: string }) {
  return (
    <header className="max-w-(--breakpoint-2xl) mx-auto pt-2">
      <div className="flex justify-between items-center pt-5 mx-5">
        <Link href={'/'} className="xl:mr-auto xl:mx-0 xl:static">
          <span className="block xl:w-[200px] xs:w-[160px] w-[130px]">
            {/* biome-ignore lint/performance/noImgElement: static SVG logo does not benefit from next/image and avoids a Next 16 runtime warning */}
            <img
              src={logo.src}
              width={200}
              height={100}
              className="dark:invert -mt-0.5 h-auto w-full transition-all duration-400 ease-in-out"
              alt="logo"
            />
          </span>
        </Link>

        <NavMenu locale={locale} />
      </div>
    </header>
  );
}
