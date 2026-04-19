import { createContext } from 'react';

export type Theme = 'dark' | 'light';

export interface ThemeProviderState {
  theme: Theme;
  toggleTheme: () => void;
}

export const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined);
