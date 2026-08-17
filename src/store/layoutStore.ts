import { create } from 'zustand';
import type { CMSUser } from '@/app/actions/cms/getUser';

export interface PublishState {
  isDirty: boolean;
  changeCount: number;
  lastModified: number;
}

interface LayoutState {
  user: CMSUser | null;
  sidePanelSections: string[];
  activeSection: string | null;
  heroSection: {
    mainImage: string | null;
    blurhashURL: string | null;
    resume_en: string | null;
    resume_it: string | null;
  } | null;
  loading: boolean;
  error: string | null;
  sidebarCollapsed: boolean;
  publishQueue: Record<string, PublishState>;

  setUser: (user: CMSUser | null) => void;
  setSidePanelSections: (sections: string[]) => void;
  setActiveSection: (section: string) => void;
  setHeroSection: (
    heroSection: {
      mainImage: string | null;
      blurhashURL: string | null;
      resume_en: string | null;
      resume_it: string | null;
    } | null
  ) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  toggleSidebar: () => void;
  registerPublishState: (key: string, state: PublishState) => void;
  unregisterPublishState: (key: string) => void;
  clearAllPublishState: () => void;
  sectionPublishCallback: (() => Promise<void>) | null;
  sectionRevertCallback: (() => void) | null;
  setSectionCallbacks: (
    publish: () => Promise<void>,
    revert: () => void
  ) => void;
  clearSectionCallbacks: () => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  user: null,
  sidePanelSections: [],
  activeSection: 'hero',
  heroSection: null,
  loading: false,
  error: null,
  sidebarCollapsed: false,
  publishQueue: {},
  sectionPublishCallback: null,
  sectionRevertCallback: null,

  setUser: (user) => set({ user }),
  setSidePanelSections: (sections) => set({ sidePanelSections: sections }),
  setActiveSection: (section) => set({ activeSection: section }),
  setHeroSection: (heroSection) => set({ heroSection }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
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
  clearAllPublishState: () => set({ publishQueue: {} }),
  setSectionCallbacks: (publish, revert) =>
    set({ sectionPublishCallback: publish, sectionRevertCallback: revert }),
  clearSectionCallbacks: () =>
    set({ sectionPublishCallback: null, sectionRevertCallback: null }),
}));
