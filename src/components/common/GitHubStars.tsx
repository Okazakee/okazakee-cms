'use client';

import { Star } from 'lucide-react';
import { useEffect, useState } from 'react';

export default function GitHubStars({ sourceLink }: { sourceLink: string }) {
  const [stars, setStars] = useState(0);

  useEffect(() => {
    const repoName = sourceLink.split('/').pop();
    if (!repoName) return;

    let cancelled = false;

    fetch(`https://api.github.com/repos/okazakee/${repoName}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setStars(data.stargazers_count ?? 0);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [sourceLink]);

  return (
    <div className="flex items-center text-darktext dark:text-lighttext">
      <Star size={20} className="mr-2" />
      <span className="mt-0.5">{stars}</span>
    </div>
  );
}
