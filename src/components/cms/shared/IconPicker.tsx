'use client';

import { Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';

interface IconPickerProps {
  value: string;
  onChange: (iconName: string) => void;
}

const POPULAR_ICONS = [
  'Link',
  'Mail',
  'MessageCircle',
  'Globe',
  'FileText',
  'Phone',
  'MapPin',
  'ExternalLink',
  'Calendar',
  'Camera',
  'Video',
  'Music',
  'Bookmark',
  'Heart',
];

type IconMap = Record<string, React.ComponentType<{ className?: string; size?: number | string }>>;

let iconMapCache: IconMap | null = null;
let iconNamesCache: string[] | null = null;

async function loadIconMap(): Promise<{ map: IconMap; names: string[] }> {
  if (iconMapCache && iconNamesCache) return { map: iconMapCache, names: iconNamesCache };

  const mod = await import('lucide-react');
  const names = Object.keys(mod).filter(
    (name) =>
      name !== 'createLucideIcon' &&
      name !== 'default' &&
      /^[A-Z]/.test(name)
  );
  const map = mod as unknown as IconMap;
  iconMapCache = map;
  iconNamesCache = names;
  return { map, names };
}

export function IconPicker({ value, onChange }: IconPickerProps) {
  const t = useTranslations('cms');
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [iconMap, setIconMap] = useState<IconMap | null>(null);
  const [iconNames, setIconNames] = useState<string[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && !iconMap) {
      loadIconMap().then(({ map, names }) => {
        setIconMap(map);
        setIconNames(names);
      });
    }
  }, [isOpen, iconMap]);

  const filtered = useMemo(() => {
    const names = iconNames || POPULAR_ICONS;
    if (!search.trim()) {
      return POPULAR_ICONS.filter((name) => names.includes(name));
    }
    const lower = search.toLowerCase();
    return names.filter((name) =>
      name.toLowerCase().includes(lower)
    ).slice(0, 50);
  }, [search, iconNames]);

  const SelectedIcon = value && iconMap ? (iconMap[value] ?? null) : null;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-white dark:bg-darkestgray border border-gray-300 dark:border-lighttext2/30 rounded-lg text-darktext dark:text-lighttext hover:border-main transition-colors w-full"
      >
        {SelectedIcon ? (
          <>
            <SelectedIcon className="w-4 h-4" />
            <span className="text-sm">{value}</span>
          </>
        ) : (
          <span className="text-sm text-gray-400">
            {t('common.chooseIcon')}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute z-30 mt-1 w-full sm:w-72 bg-bglight dark:bg-darkergray border border-gray-200 dark:border-darkgray rounded-xl shadow-lg overflow-hidden">
          <div className="p-2 border-b border-gray-100 dark:border-darkgray/50">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-8 pr-8 py-2 text-sm bg-gray-50 dark:bg-darkestgray border border-gray-200 dark:border-darkgray/50 rounded-lg text-darktext dark:text-lighttext focus:outline-none focus:border-main"
                placeholder={t('common.searchSections')}
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-darktext dark:hover:text-lighttext"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {!search.trim() && (
            <div className="px-3 py-1.5 text-xs font-medium text-gray-400 uppercase">
              {t('common.icon')} — popular
            </div>
          )}

          <div className="max-h-48 overflow-y-auto p-2">
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-1">
              {filtered.map((name) => {
                const Icon = iconMap?.[name];
                if (!Icon) return null;
                const isSelected = value === name;
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => {
                      onChange(name);
                      setIsOpen(false);
                      setSearch('');
                    }}
                    title={name}
                    className={`p-2 rounded-lg flex flex-col items-center gap-1 transition-colors ${
                      isSelected
                        ? 'bg-main text-white'
                        : 'hover:bg-gray-100 dark:hover:bg-darkgray text-darktext dark:text-lighttext'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-[10px] leading-tight truncate w-full text-center">
                      {name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
