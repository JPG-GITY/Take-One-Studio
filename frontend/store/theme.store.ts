'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Theme = 'dark' | 'light' | 'system'

interface ThemeStore {
  theme: Theme
  setTheme: (t: Theme) => void
}

// App-level UI preference (not project data), persisted on its own key. Default
// 'dark' preserves the current look; the no-flash script in the layout reads the
// SAME key before paint.
export const useThemeStore = create<ThemeStore>()(
  persist(
    (set) => ({
      theme: 'dark',
      setTheme: (theme) => set({ theme }),
    }),
    { name: 'takeone-theme' },
  ),
)
