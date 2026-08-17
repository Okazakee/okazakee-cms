'use client';

import { CircleUserRound, Loader2 } from 'lucide-react';
import { GithubIcon } from '@/components/common/BrandIcons';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { login } from '@/app/actions/cms/login';

// Component that reads search params - must be wrapped in Suspense
function LoginFormContent({
  initialError,
}: {
  initialError?: string | null;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError || null);
  const [isLoading, setIsLoading] = useState(false);
  const [isGitHubLoading, setIsGitHubLoading] = useState(false);
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const locale = pathname.split('/')[1] || 'en';

  // Check for error from OAuth callback
  useEffect(() => {
    const errorParam = searchParams.get('error');
    if (errorParam) {
      setError(errorParam);
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    const result = await login(email, password);
    if (result?.error) {
      setError(result.error);
      setIsLoading(false);
    } else if (result?.success) {
      // Redirect on client side
      window.location.href = `/${locale}${result.redirectTo}`;
    }
  };

  const handleGitHubLogin = async () => {
    setIsGitHubLoading(true);
    setError(null);
    window.location.href = `/${locale}/auth/github/start`;
  };

  return (
    <>
      <CircleUserRound size={100} className="mx-auto mb-6 text-main" />

      <h1 className="text-2xl font-bold text-center mb-6 text-darktext dark:text-lighttext">
        CMS Login
      </h1>

      {/* GitHub Login Button */}
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

      {/* Divider */}
      <div className="flex items-center gap-4 my-6">
        <div className="flex-1 h-px bg-lighttext2/30" />
        <span className="text-lighttext2 text-sm">or</span>
        <div className="flex-1 h-px bg-lighttext2/30" />
      </div>

      {/* Email/Password Form */}
      <form onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-md px-4 py-2 border focus:outline-hidden mb-4 text-darktext dark:text-lighttext dark:bg-darkgray"
          disabled={isLoading}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-md px-4 py-2 border focus:outline-hidden mb-4 text-darktext dark:text-lighttext dark:bg-darkgray"
          disabled={isLoading}
        />

        {error && (
          <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-3 mb-4">
            <p className="text-red-500 text-sm">{error}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-2 text-xl bg-secondary text-lighttext transition-all py-3 rounded-lg hover:bg-main focus:outline-hidden disabled:opacity-50"
        >
          {isLoading && <Loader2 className="w-5 h-5 animate-spin" />}
          Sign In
        </button>
      </form>
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
