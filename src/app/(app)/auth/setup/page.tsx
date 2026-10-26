import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createClient } from '@/utils/supabase/server';
import { OnboardingSetup } from './OnboardingSetup';

export const metadata: Metadata = {
  title: 'Finish setup',
};

/**
 * Protected post-invitation setup surface.
 *
 * The proxy already requires an allowlisted session for every non-public
 * route; this server check is the second boundary (and guarantees the page
 * renders nothing without a session). It grants no authority of its own — it
 * only offers passkey enrollment for the identity the invite just confirmed.
 */
export default async function AuthSetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  return <OnboardingSetup />;
}
