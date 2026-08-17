import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { publicConfig } from './src/config/public';

const withNextIntl = createNextIntlPlugin();

if (!publicConfig.supabaseUrl) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL is required to build the application'
  );
}

const supabaseHostname = publicConfig.supabaseHostname;
const revalidateSeconds = publicConfig.isrRevalidationSeconds;
const thirtyDaysInSeconds = 60 * 60 * 24 * 30;

const nextConfig: NextConfig = {
  cacheLife: {
    default: {
      stale: revalidateSeconds,
      revalidate: revalidateSeconds,
      expire: thirtyDaysInSeconds,
    },
    supabaseContent: {
      stale: revalidateSeconds,
      revalidate: revalidateSeconds,
      expire: thirtyDaysInSeconds,
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: supabaseHostname,
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
        pathname: '/**',
      },
    ],
    // Optimize for Vercel image transformation limits:
    // - cache transformed images for ~31 days
    // - only generate WebP variants (uploads are already WebP via imageProcessor)
    // - limit the set of responsive widths to reduce unique transforms
    minimumCacheTTL: 2678400, // 31 days in seconds
    formats: ['image/webp'],
    deviceSizes: [640, 768, 1024, 1280],
    imageSizes: [256, 384, 512],
  },
  // NOTE: sharp is intentionally NOT in serverExternalPackages. Externalizing
  // it broke sharp's __dirname-relative native requires under Turbopack's
  // external module loader at runtime (ERR_DLOPEN_FAILED on libvips). Letting
  // Turbopack handle the native addon (copy + resolve) works on Vercel.
  cacheComponents: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
