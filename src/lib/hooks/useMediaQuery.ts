'use client';

import { useEffect, useState } from 'react';

export function useMediaQuery(query: string, defaultValue = false): boolean {
  const [matches, setMatches] = useState(defaultValue);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQueryList = window.matchMedia(query);
    const updateMatch = () => setMatches(mediaQueryList.matches);

    updateMatch();

    if ('addEventListener' in mediaQueryList) {
      mediaQueryList.addEventListener('change', updateMatch);
      return () => mediaQueryList.removeEventListener('change', updateMatch);
    }

    if ('addListener' in mediaQueryList) {
      const legacyMediaQueryList = mediaQueryList as MediaQueryList & {
        addListener: (listener: () => void) => void;
        removeListener: (listener: () => void) => void;
      };

      legacyMediaQueryList.addListener(updateMatch);
      return () => legacyMediaQueryList.removeListener(updateMatch);
    }

    return;
  }, [query]);

  return matches;
}
