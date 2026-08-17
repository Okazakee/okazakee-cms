'use client';

import { FileUser } from 'lucide-react';
import Link from 'next/link';

interface ResumeButtonProps {
  resumeLink: string;
  locale: string;
}

export default function ResumeButton({
  resumeLink,
  locale,
}: ResumeButtonProps) {
  return (
    <Link
      data-umami-event="Resume button"
      href={resumeLink}
      target="_blank"
      style={
        {
          '--dyn-color': '#4B556399', // A gray color with transparency
          '--hover-color': '#4B5563',
        } as React.CSSProperties
      }
      className="text-lighttext mb-5 lg:mb-0 last:mb-0 transition-all hover:scale-105 border-2
            border-main rounded-2xl bg-(--hover-color) lg:bg-(--dyn-color) lg:hover:bg-(--hover-color)"
    >
      <div className="transition-all ease-in-out lg:my-0 my-2 lg:w-40 lg:h-40">
        <div className="h-full flex lg:flex-col justify-center items-center">
          <FileUser
            className="lg:mr-0 mr-5 dark:text-lighttext lg:w-[100px] w-16 lg:h-auto h-14 xs:h-16"
            size={80}
            strokeWidth={1}
          />
          <h3 className="text-xl xs:text-2xl text-left w-28 lg:text-center lg:w-auto">
            {locale === 'it' ? 'Curriculum' : 'Resume'}
          </h3>
        </div>
      </div>
    </Link>
  );
}
