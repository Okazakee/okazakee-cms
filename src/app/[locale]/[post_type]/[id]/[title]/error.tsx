'use client';

import { AlertTriangle, ArrowLeft, Home } from 'lucide-react';
import Link from 'next/link';

export default function ErrorPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center max-w-md mx-auto">
        <div className="mb-8 flex justify-center">
          <div className="relative">
            <AlertTriangle
              className="w-24 h-24 text-red-500 dark:text-red-400 mx-auto"
              strokeWidth={1.5}
            />
            <div className="absolute inset-0 bg-red-500/10 dark:bg-red-400/10 rounded-full blur-xl" />
          </div>
        </div>

        <h1 className="text-4xl md:text-6xl font-bold mb-4 text-darktext dark:text-lighttext">
          Oops!
        </h1>

        <p className="text-lg md:text-xl text-gray-600 dark:text-gray-300 mb-8">
          Something went wrong while loading this post.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <button
            type="button"
            onClick={() => window.history.back()}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-main hover:bg-main/90 text-white rounded-lg transition-colors duration-200 font-medium"
          >
            <ArrowLeft className="w-4 h-4" />
            Go Back
          </button>

          <Link
            href="/"
            className="flex items-center justify-center gap-2 px-6 py-3 border border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500 text-darktext dark:text-lighttext rounded-lg transition-colors duration-200 font-medium"
          >
            <Home className="w-4 h-4" />
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
