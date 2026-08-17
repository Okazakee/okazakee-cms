import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/api/',
        '/actions/',
        '/hooks/',
        '/store/',
        '/utils/',
        '/*.json$',
        '/fonts/',
      ],
    },
    sitemap: `${process.env.DOMAIN_URL}/sitemap.xml`,
    host: process.env.DOMAIN_URL,
  };
}
