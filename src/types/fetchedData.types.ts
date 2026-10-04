import type { NavAnchorDraft } from '@/utils/cms/navAnchors';
import type { PostButton as PortfolioPostButton } from '@/utils/cms/postButtons';

export type HeroShape = 'pebble' | 'square' | 'rounded' | 'squircle';

export type TypewriterTarget = 'role1' | 'role2' | 'all';

export type HeroSection = {
  id: number;
  propic: string;
  blurhashURL: string;
  /** Portrait preset; null before the column existed — renders as `pebble`. */
  shape: string | null;
  typewriter: boolean;
  typewriter_target: string | null;
};

/** The `hero_section` row fields the CMS edits (boot data + live drafts). */
export type HeroSettings = {
  mainImage: string | null;
  blurhashURL: string | null;
  resume_en: string | null;
  resume_it: string | null;
  /** Portrait preset; null before the column existed — renders as `pebble`. */
  shape: string | null;
  typewriter: boolean;
  typewriter_target: string | null;
};

/**
 * The single `site_settings` row as the CMS edits it. Every field is nullable:
 * a null logo means "keep the bundled asset" and a null anchor means "keep the
 * href the public site has always computed".
 */
export type SiteSettings = {
  /** Dark-theme logo URL; null renders the bundled asset. */
  header_logo_dark: string | null;
  /** Light-theme logo URL; null renders the bundled asset. */
  header_logo_light: string | null;
  /** One anchor per nav item, index-aligned with `header.buttons.N`. */
  nav_anchors: NavAnchorDraft[];
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
  /** Optional http(s) URL; renders the public tile as an external link. */
  link: string | null;
  /** Order inside the category; null sorts last (see canonical/skillOrder). */
  position: number | null;
};

export type PortfolioPost = {
  id: number;
  created_at: string;
  title_en: string;
  title_it: string;
  image: string;
  /** Legacy link columns: kept in the DB, no longer written by the editor
   * (buttons replaced them) and only read to derive buttons for old rows. */
  source_link?: string;
  demo_link?: string;
  description_en: string;
  description_it: string;
  body_en: string;
  body_it: string;
  blurhashURL: string;
  post_tags: string;
  store_link?: string;
  fdroid_link?: string | null;
  website?: string | null;
  ios_store_link?: string | null;
  views: number;
  hidden: boolean;
  author_id?: string;
  /** Ordered quick-link buttons; null/empty falls back to the legacy columns. */
  buttons: PortfolioPostButton[] | null;
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
  created_at: string;
};
