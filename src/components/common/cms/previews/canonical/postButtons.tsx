import {
  CirclePlay,
  ExternalLink,
  Globe,
  Link2,
  Smartphone,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { PostButton, PostButtonKind } from '@/utils/cms/postButtons';
import { AppleIcon, GithubIcon } from './BrandIcons';

/**
 * The preview mirrors what okazakee-ws renders for `portfolio_posts.buttons`.
 * The CMS owns the order and the URL; the website owns the icon and the label
 * of a known kind, so those live here as static copy rather than as
 * CMS-editable `posts-section` translations. Keep these two in step with
 * `okazakee-ws/src/utils/postButtons.ts` and `src/i18n/postButtons.ts`.
 *
 * `website` deliberately has no label: the globe button has always rendered as
 * an icon with no text.
 */

export const previewButtonEvents: Record<PostButtonKind, string> = {
  website: 'Website button',
  source: 'View Source Code button',
  demo: 'View Demo button',
  store: 'Play Store button',
  fdroid: 'F-Droid button',
  ios: 'iOS Store button',
  custom: 'Custom link button',
};

const presetLabels = {
  en: {
    source: 'Source',
    demo: 'Demo',
    store: 'Google Play',
    fdroid: 'F-Droid',
    ios: 'App Store',
    custom: 'Link',
  },
  it: {
    source: 'Codice',
    demo: 'Demo',
    store: 'Google Play',
    fdroid: 'F-Droid',
    ios: 'App Store',
    custom: 'Link',
  },
} as const;

export function previewButtonIcon(kind: PostButtonKind): ReactNode {
  switch (kind) {
    case 'website':
      return <Globe size={14} />;
    case 'source':
      return <GithubIcon size={14} />;
    case 'demo':
      return <ExternalLink size={14} />;
    case 'store':
      return <CirclePlay size={14} />;
    case 'fdroid':
      return <Smartphone size={14} />;
    case 'ios':
      return <AppleIcon size={14} />;
    default:
      return <Link2 size={14} />;
  }
}

export function previewButtonLabel(
  button: PostButton,
  locale: string
): string | null {
  if (button.kind === 'website') return null;
  if (button.kind === 'custom') return button.label ?? presetLabels.en.custom;
  const messages = locale === 'it' ? presetLabels.it : presetLabels.en;
  return messages[button.kind];
}
