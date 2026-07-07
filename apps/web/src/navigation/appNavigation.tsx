import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router';

interface AppNavigationContextValue {
  pathname: string;
  push: (to: string) => void;
}

const AppNavigationContext = createContext<AppNavigationContextValue | null>(null);
const LOCATION_CHANGE_EVENT = 'stark-ballot:navigation';

function getBrowserPathname(): string {
  if (typeof window === 'undefined') {
    return '/';
  }
  return window.location.pathname;
}

function subscribeBrowserPathname(callback: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }
  window.addEventListener('popstate', callback);
  window.addEventListener(LOCATION_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener('popstate', callback);
    window.removeEventListener(LOCATION_CHANGE_EVENT, callback);
  };
}

function pushBrowserHistory(to: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.history.pushState({}, '', to);
  window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));
}

export function AppNavigationProvider({ children }: { children: ReactNode }): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const value = useMemo<AppNavigationContextValue>(
    () => ({
      pathname: location.pathname,
      push: (to: string) => {
        void navigate(to);
      },
    }),
    [location.pathname, navigate],
  );

  return <AppNavigationContext.Provider value={value}>{children}</AppNavigationContext.Provider>;
}

export function useAppRouter(): { push: (to: string) => void } {
  const context = useContext(AppNavigationContext);
  return useMemo(
    () => ({
      push: context?.push ?? pushBrowserHistory,
    }),
    [context],
  );
}

export function useAppPathname(): string {
  const context = useContext(AppNavigationContext);
  const fallbackPathname = useSyncExternalStore(subscribeBrowserPathname, getBrowserPathname, () => '/');
  return context?.pathname ?? fallbackPathname;
}

type AppLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
};

export function AppLink({ href, onClick, target, children, ...props }: AppLinkProps): ReactElement {
  const router = useAppRouter();
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (
        event.defaultPrevented ||
        target ||
        event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.button !== 0 ||
        !href.startsWith('/')
      ) {
        return;
      }
      event.preventDefault();
      router.push(href);
    },
    [href, onClick, router, target],
  );

  return (
    <a href={href} onClick={handleClick} target={target} {...props}>
      {children}
    </a>
  );
}
