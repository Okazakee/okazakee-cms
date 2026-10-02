import { Star } from 'lucide-react';

/**
 * Pure star glyph for the preview meta row. The public site fetches the live
 * GitHub count; previews must stay offline, so the icon is rendered without a
 * network round-trip.
 */
export function StarIcon({
  size = 14,
  className,
}: {
  size?: number | string;
  className?: string;
}) {
  return <Star className={className} size={size} />;
}
