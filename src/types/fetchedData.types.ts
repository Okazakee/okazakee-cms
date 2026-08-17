export type HeroSection = {
  id: number;
  propic: string;
  blurhashURL: string;
};

export type SkillsCategory = {
  id: number;
  name: string;
  position: number;
  skills: Skill[];
};

export type Skill = {
  id: number;
  title: string;
  icon: string;
  invert: boolean;
  category_id: number;
  blurhashURL: string;
};

export type PortfolioPost = {
  id: number;
  created_at: string;
  title_en: string;
  title_it: string;
  image: string;
  source_link: string;
  demo_link: string;
  description_en: string;
  description_it: string;
  body_en: string;
  body_it: string;
  blurhashURL: string;
  post_tags: string;
  store_link: string;
  fdroid_link: string | null;
  website: string | null;
  ios_store_link: string | null;
  views: number;
  hidden: boolean;
  author_id?: string;
};

export type BlogPost = {
  title: string;
  id: number;
  created_at: string;
  title_en: string;
  title_it: string;
  image: string;
  description_en: string;
  description_it: string;
  body_en: string;
  body_it: string;
  blurhashURL: string;
  post_tags: string;
  views: number;
  hidden: boolean;
  author_id?: string;
};

export type Contact = {
  id: number;
  position: number;
  label: string;
  icon: string;
  link: string;
  bg_color: string;
};

export type ResumeData = {
  resume_en: string;
  resume_it: string;
};

export type User = {
  id: string;
  role: string;
  email: string;
  propic: string;
};

export type RemoteType = 'full' | 'hybrid' | 'onSite';

export type CareerEntry = {
  id: number;
  title: string;
  company: string;
  website_url: string;
  logo: string;
  blurhashURL: string;
  location_en: string;
  location_it: string;
  remote: RemoteType;
  startDate: string;
  endDate: string | null;
  description_en: string;
  description_it: string;
  skills: string;
  company_description_en: string;
  company_description_it: string;
  created_at: string;
};
