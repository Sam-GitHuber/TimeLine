import { createContext, useCallback, useContext, useMemo, useState } from "react";

// Groups are surfaced through a *companion* drawer that mirrors the messages
// drawer — but docked to the LEFT edge instead of the right. Where messaging is
// a place you act *inside* the panel, this drawer is only a switcher: it lists
// the groups you belong to, and picking one navigates the main column to that
// group's full-width timeline (`/g/:id`). So its state is just open/closed —
// there are no sub-views to walk between. Keeping it out of the router (like
// messaging) means opening it never unmounts the feed underneath.
const GroupsDrawerContext = createContext(null);

export function useGroupsDrawer() {
  const ctx = useContext(GroupsDrawerContext);
  if (!ctx)
    throw new Error("useGroupsDrawer must be used within GroupsDrawerProvider");
  return ctx;
}

// `initialOpen` exists only so tests can render the drawer already open; the
// app always mounts it closed.
export function GroupsDrawerProvider({ children, initialOpen = false }) {
  const [isOpen, setIsOpen] = useState(initialOpen);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  const value = useMemo(
    () => ({ isOpen, open, close, toggle }),
    [isOpen, open, close, toggle]
  );

  return (
    <GroupsDrawerContext.Provider value={value}>
      {children}
    </GroupsDrawerContext.Provider>
  );
}
