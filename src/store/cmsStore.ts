import { create } from 'zustand';
import type { CMSUser } from '@/app/actions/cms/getUser';
import type { HeroSettings } from '@/types/fetchedData.types';

export interface PublishState {
  isDirty: boolean;
  changeCount: number;
  lastModified: number;
}

export interface SectionCallbacks {
  publish: () => Promise<void>;
  revert: () => void;
}

export interface PublishFailure {
  key: string;
  error: string;
}

/** Hero and Resume updates preserve the other editor's committed fields. */
export function mergeHeroSettings(
  current: HeroSettings | null,
  patch: Partial<HeroSettings>
): HeroSettings {
  return {
    mainImage: current?.mainImage ?? null,
    blurhashURL: current?.blurhashURL ?? null,
    resume_en: current?.resume_en ?? null,
    resume_it: current?.resume_it ?? null,
    shape: current?.shape ?? null,
    ...patch,
  };
}

interface CmsState {
  user: CMSUser | null;
  sidePanelSections: string[];
  activeSection: string | null;
  heroSection: HeroSettings | null;
  loading: boolean;
  error: string | null;
  warning: string | null;
  publishQueue: Record<string, PublishState>;
  sectionCallbacks: Record<string, SectionCallbacks>;
  isPublishingAll: boolean;

  setUser: (user: CMSUser | null) => void;
  setSidePanelSections: (sections: string[]) => void;
  setActiveSection: (section: string) => void;
  setHeroSection: (heroSection: HeroSettings | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setWarning: (warning: string | null) => void;
  registerPublishState: (key: string, state: PublishState) => void;
  unregisterPublishState: (key: string) => void;
  registerSectionCallbacks: (key: string, callbacks: SectionCallbacks) => void;
  unregisterSectionCallbacks: (key: string) => void;
  /**
   * Publishes every dirty section sequentially. Sections whose handler throws
   * are recorded as failures and the sequence continues. The in-flight lock
   * makes re-entrant calls a no-op. Returns the failures (empty on success).
   */
  publishAll: () => Promise<PublishFailure[]>;
}

export const useCmsStore = create<CmsState>((set, get) => ({
  user: null,
  sidePanelSections: [],
  activeSection: null,
  heroSection: null,
  loading: false,
  error: null,
  warning: null,
  publishQueue: {},
  sectionCallbacks: {},
  isPublishingAll: false,

  setUser: (user) => set({ user }),
  setSidePanelSections: (sections) => set({ sidePanelSections: sections }),
  setActiveSection: (section) => set({ activeSection: section }),
  setHeroSection: (heroSection) => set({ heroSection }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setWarning: (warning) => set({ warning }),
  registerPublishState: (key, state) =>
    set((prev) => ({
      publishQueue: { ...prev.publishQueue, [key]: state },
    })),
  unregisterPublishState: (key) =>
    set((prev) => {
      const next = { ...prev.publishQueue };
      delete next[key];
      return { publishQueue: next };
    }),
  registerSectionCallbacks: (key, callbacks) =>
    set((prev) => ({
      sectionCallbacks: { ...prev.sectionCallbacks, [key]: callbacks },
    })),
  unregisterSectionCallbacks: (key) =>
    set((prev) => {
      const next = { ...prev.sectionCallbacks };
      delete next[key];
      return { sectionCallbacks: next };
    }),
  publishAll: async () => {
    if (get().isPublishingAll) return [];

    set({ isPublishingAll: true, error: null });
    const failures: PublishFailure[] = [];

    try {
      const { publishQueue, sidePanelSections } = get();

      // Publish in navigation order first, then any dirty key not listed.
      const ordered: string[] = [];
      for (const key of sidePanelSections) {
        if (publishQueue[key]?.isDirty && !ordered.includes(key)) {
          ordered.push(key);
        }
      }
      for (const key of Object.keys(publishQueue)) {
        if (publishQueue[key]?.isDirty && !ordered.includes(key)) {
          ordered.push(key);
        }
      }

      for (const key of ordered) {
        const callbacks = get().sectionCallbacks[key];
        if (!callbacks) {
          failures.push({
            key,
            error: `No publish handler registered for "${key}"`,
          });
          continue;
        }
        try {
          set({ error: null });
          await callbacks.publish();
          // Section handlers may surface action errors without throwing.
          if (get().error) failures.push({ key, error: get().error as string });
        } catch (err) {
          failures.push({
            key,
            error: err instanceof Error ? err.message : 'Publish failed',
          });
        }
      }

      if (failures.length > 0) {
        set({
          error: failures
            .map((failure) => `${failure.key}: ${failure.error}`)
            .join('\n'),
        });
      }
    } finally {
      set({ isPublishingAll: false });
    }

    return failures;
  },
}));
