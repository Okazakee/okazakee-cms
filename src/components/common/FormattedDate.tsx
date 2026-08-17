'use client';

import { formatDMY } from '@/utils/formatDate';

interface FormattedDateProps {
  date: string | null | undefined;
}

export default function FormattedDate({ date }: FormattedDateProps) {
  const formattedDate = formatDMY(date);
  return <span>{formattedDate}</span>;
}
