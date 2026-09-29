import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'deployforge.theme';

function apply(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function initTheme(): void {
  apply((localStorage.getItem(KEY) as ThemePref | null) ?? 'system');
}

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(() => (localStorage.getItem(KEY) as ThemePref | null) ?? 'system');
  useEffect(() => {
    apply(pref);
    localStorage.setItem(KEY, pref);
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = () => apply('system');
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [pref]);
  return [pref, setPref];
}
