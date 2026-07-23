/**
 * Local, per-device app preferences — the settings that are the *client's* to
 * remember, not the server's.
 *
 * Right now that's exactly one: whether the home feed merges in posts from your
 * groups (E3a's include-groups toggle, moved out of the feed header and into
 * Settings — E4b). The web keeps this in `localStorage` per-browser; the phone's
 * equivalent is per-device, so it lives here rather than on the account. Two
 * screens read it (the feed and the settings toggle), so it's a small context
 * rather than local state in either one.
 *
 * **Persistence uses `expo-secure-store`** — not because the value is a secret
 * (it plainly isn't), but because it's the only key-value store already in the
 * app, and reaching for it avoids adding `@react-native-async-storage` (a native
 * module, hence a dev-build rebuild) for a single boolean. If more preferences
 * accrue and a plain store is wanted, that's the time to add one.
 */

import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

const INCLUDE_GROUPS_KEY = 'feed.includeGroups';

type PreferencesValue = {
  /**
   * Merge your groups' posts into the home feed, strictly chronologically
   * (`?include_groups=1`). Off by default. Only posts merge — group *events*
   * live on the group pages and the Calendar tab, never in the home feed.
   */
  includeGroupsInFeed: boolean;
  setIncludeGroupsInFeed: (value: boolean) => void;
};

const PreferencesContext = createContext<PreferencesValue | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [includeGroupsInFeed, setValue] = useState(false);

  // Load the persisted value once on mount. Until it resolves the default (off)
  // shows; a stored "on" then flips it in. A one-frame flash to off is invisible
  // and harmless — the feed simply refetches without the group posts for an
  // instant, which the user never sees on a cold start behind the splash.
  useEffect(() => {
    let cancelled = false;
    SecureStore.getItemAsync(INCLUDE_GROUPS_KEY).then((stored) => {
      if (!cancelled && stored === '1') setValue(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setIncludeGroupsInFeed = useCallback((value: boolean) => {
    setValue(value);
    // Write-through, fire-and-forget: a failed write only means the choice
    // doesn't survive a restart, which isn't worth interrupting the user for.
    void SecureStore.setItemAsync(INCLUDE_GROUPS_KEY, value ? '1' : '0');
  }, []);

  const value = useMemo(
    () => ({ includeGroupsInFeed, setIncludeGroupsInFeed }),
    [includeGroupsInFeed, setIncludeGroupsInFeed]
  );

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesValue {
  const context = useContext(PreferencesContext);
  if (!context) {
    throw new Error('usePreferences must be used inside a PreferencesProvider');
  }
  return context;
}
