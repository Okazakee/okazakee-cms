import { ErrorDiv } from '@components/common/ErrorDiv';
import { getCareerEntries } from '@/utils/getData';
import { CareerClient } from './CareerClient';

interface CareerEntry {
  id: string;
  title: string;
  company: string;
  remote: string;
  startDate: string;
  endDate: string | null;
  skills: string;
  logo: string;
  blurhashurl: string;
  website_url: string;
  [key: `location_${string}`]: string;
  [key: `description_${string}`]: string;
  [key: `company_description_${string}`]: string;
}

export default async function Career({ locale }: { locale: string }) {
  const careerEntries = (await getCareerEntries()) as unknown as CareerEntry[];

  if (!careerEntries) {
    return <ErrorDiv>Error loading Career data</ErrorDiv>;
  }

  return <CareerClient careerEntries={careerEntries} locale={locale} />;
}
