'use client';
import { debounce } from '@/utils/debounce';
import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import validator from 'validator';
import { searchPosts } from '@/app/actions/search';
import type { BlogPost, PortfolioPost } from '@/types/fetchedData.types';
import { TokenBucket } from '@/utils/tokenBucket';

export default function Searchbar({
  post_type,
  SetPosts,
  initialPosts,
  SetIsRateLimited,
  locale,
}: {
  post_type: string;
  SetPosts: Dispatch<SetStateAction<BlogPost[] | PortfolioPost[]>>;
  SetIsRateLimited: Dispatch<SetStateAction<boolean>>;
  initialPosts: BlogPost[] | PortfolioPost[];
  locale: string;
}) {
  const [searchFilter, setSearchFilter] = useState('');
  const tokenBucketRef = useRef(new TokenBucket(5, 1)); // 5 tokens, refill 1 token per second

  const debouncedSearch = useMemo(
    () =>
      debounce(async (searchQuery: string) => {
        if (tokenBucketRef.current.tryConsume()) {
          SetIsRateLimited(false);
          try {
            const newPosts = await searchPosts(post_type, searchQuery, locale);
            SetPosts(newPosts.posts || []);
          } catch (error) {
            console.error('Search error:', error);
            // Handle error (e.g., show error message to user)
          }
        } else {
          SetIsRateLimited(true);
          console.log(
            'Rate limit exceeded. Please wait before searching again.'
          );
          // You could also show a user-friendly message here
        }
      }, 300),
    [SetIsRateLimited, SetPosts, post_type, locale]
  );

  useEffect(() => {
    if (searchFilter.length > 2 && searchFilter.length < 40) {
      debouncedSearch(validator.escape(searchFilter));
    } else if (searchFilter.length === 0) {
      SetPosts(initialPosts);
    }

    // Cleanup function to cancel any pending debounced calls
    return () => {
      debouncedSearch.cancel();
    };
  }, [searchFilter, debouncedSearch, SetPosts, initialPosts]);

  const t = useTranslations('posts-section');

  return (
    <div className="mb-10 mx-10 sm:mx-auto max-w-xl relative items-center">
      <input
        type="text"
        value={searchFilter}
        onChange={(e) => setSearchFilter(e.target.value)}
        placeholder={t('searchbar')}
        className="md:text-xl w-full p-2 pl-10 rounded-xl border-2 bg-lighttext border-main focus:outline-hidden placeholder:text-darktext placeholder:opacity-70 text-darktext focus:placeholder:opacity-0 placeholder:text-sm xs:placeholder:text-base sm:placeholder:text-xl"
      />
      <Search
        className="absolute left-3 top-1/2 transform-gpu -translate-y-1/2 stroke-main"
        size={20}
        strokeWidth={2.5}
      />
    </div>
  );
}
