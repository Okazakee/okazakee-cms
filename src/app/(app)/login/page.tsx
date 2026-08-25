'use client';

import { CircleUserRound, Loader2 } from 'lucide-react';
import { GithubIcon } from '@/components/common/BrandIcons';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

// Component that reads search params - must be wrapped in Suspense
function LoginFormContent({
  initialError,
}: {
  initialError?: string | null;
}) {
  const [error, setError] = useState<string | null>(initialError || null);
  const [isGitHubLoading, setIsGitHubLoading] = useState(false);
  const searchParams = useSearchParams();

  // Check for error from OAuth callback
  useEffect(() => {
    const errorParam = searchParams.get('error');
    if (errorParam) {
      setError(errorParam);
    }
  }, [searchParams]);

  // GitHub OAuth is the only sign-in path: navigation happens here and the
  // callback route owns every post-auth step (allowlist enforcement, profile
  // sync, canonical redirect).
  const handleGitHubLogin = () => {
    setIsGitHubLoading(true);
    setError(null);
    window.location.href = '/auth/github/start';
  };

  return (
    <>
      <CircleUserRound size={100} className="mx-auto mb-6 text-main" />

      <h1 className="text-2xl font-bold text-center mb-6 text-darktext dark:text-lighttext">
        CMS Login
      </h1>

      <button
        type="button"
        onClick={handleGitHubLogin}
        disabled={isGitHubLoading}
        className="w-full flex items-center justify-center gap-3 text-lg bg-[#24292e] text-white transition-all py-3 rounded-lg hover:bg-[#1b1f23] focus:outline-hidden mb-4 disabled:opacity-50"
      >
        {isGitHubLoading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <GithubIcon className="w-5 h-5" />
        )}
        Continue with GitHub
      </button>

      {error && (
        <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-3 mb-4">
          <p className="text-red-500 text-sm">{error}</p>
        </div>
      )}
    </>
  );
}

// Main page component with Suspense boundary
export default function LoginPage() {
  return (
    <section className="my-52 flex items-center justify-center">
      <div className="p-8 rounded-xl w-full max-w-md border border-main">
        <Suspense
          fallback={
            <div className="flex flex-col items-center justify-center min-h-[400px]">
              <Loader2 className="w-8 h-8 animate-spin text-main mb-4" />
              <p className="text-lighttext2">Loading...</p>
            </div>
          }
        >
          <LoginFormContent />
        </Suspense>
      </div>
    </section>
  );
}
