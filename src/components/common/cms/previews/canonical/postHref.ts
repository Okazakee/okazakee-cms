export interface PostHrefOptions {
  locale: string;
  postType: string;
  id: number | string;
  title: string;
}

/**
 * Slug used by the post cards and the detail route. Titles arrive from the CMS,
 * so non-ASCII characters are stripped rather than transliterated.
 */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-');
}

export function getPostHref({
  locale,
  postType,
  id,
  title,
}: PostHrefOptions): string {
  return `/${locale}/${postType}/${id}/${slugifyTitle(title)}`;
}
