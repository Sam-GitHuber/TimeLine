/**
 * The "⋯" menu, on both platforms (Phase 10).
 *
 * **Why this exists rather than an `Alert` fallback.** The original Android
 * fallback passed the whole menu to `Alert.alert`, which looks reasonable and is
 * quietly catastrophic: React Native's Android `Alert` keeps
 * **`buttons.slice(0, 3)`** — *"At most three buttons (neutral, negative,
 * positive). Ignore rest."* — and defaults to `cancelable: false`. The group menu
 * offers up to seven. So an Android admin saw Plan / Invite / Members and
 * **Edit group, Delete group, Leave group and Cancel were silently dropped**,
 * inside a dialog that back and outside-tap could not dismiss. Editing, deleting
 * and leaving a group were unreachable on Android, and the only three ways out of
 * the dialog all navigated somewhere else.
 *
 * The Alert also ignores per-button `style`, so nothing marked destructive read
 * as destructive: Delete looked exactly like Cancel.
 *
 * `Alert` is right for a *confirmation* — two or three buttons, which is what it
 * is for — and wrong for a menu. Menus get this: a real bottom sheet, which has
 * no button limit, honours dismissal, and can show a destructive item in red.
 */

import { useCallback, useState } from 'react';
import {
  ActionSheetIOS,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fontSize, radius, spacing } from '@/theme';

export type ActionMenuItem = {
  label: string;
  onPress: () => void;
  /** Drawn in red, and marked destructive to the iOS sheet. */
  destructive?: boolean;
};

export type ActionMenuRequest = {
  /** Shown as the sheet's heading on Android; iOS sheets take no title here. */
  title?: string;
  items: ActionMenuItem[];
  /**
   * Closed without choosing anything — Cancel, the backdrop, or Android's Back.
   *
   * Optional, and most menus want nothing here: the caller simply carries on.
   * It exists for a menu whose result is *awaited* (`usePhotoPicker` wraps this
   * one in a promise), where "dismissed" has to be delivered or the caller waits
   * forever and its button is dead for the rest of the screen's life.
   */
  onCancel?: () => void;
};

/**
 * Open a "⋯" menu. Returns the opener plus the element to render.
 *
 * The element is `null` on iOS — `ActionSheetIOS` is imperative and draws
 * nothing in the tree — so callers render `{menu}` unconditionally and it costs
 * nothing there.
 *
 * ```tsx
 * const { openMenu, menu } = useActionMenu();
 * // …
 * <Pressable onPress={() => openMenu({ title: 'Post options', items })} />
 * {menu}
 * ```
 */
export function useActionMenu(): {
  openMenu: (request: ActionMenuRequest) => void;
  menu: React.ReactElement | null;
} {
  const [request, setRequest] = useState<ActionMenuRequest | null>(null);

  const openMenu = useCallback((next: ActionMenuRequest) => {
    if (Platform.OS === 'ios') {
      const labels = [...next.items.map((i) => i.label), 'Cancel'];
      const destructiveIndex = next.items.findIndex((i) => i.destructive);
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: labels,
          destructiveButtonIndex:
            destructiveIndex >= 0 ? destructiveIndex : undefined,
          cancelButtonIndex: labels.length - 1,
        },
        (index) => {
          // The cancel index has no item behind it — that's the dismissal.
          const item = next.items[index];
          if (item) item.onPress();
          else next.onCancel?.();
        }
      );
      return;
    }
    setRequest(next);
  }, []);

  return {
    openMenu,
    menu: request ? (
      <AndroidSheet
        request={request}
        onChoose={(item) => {
          setRequest(null);
          item.onPress();
        }}
        onDismiss={() => {
          setRequest(null);
          request.onCancel?.();
        }}
      />
    ) : null,
  };
}

function AndroidSheet({
  request,
  onChoose,
  onDismiss,
}: {
  request: ActionMenuRequest;
  onChoose: (item: ActionMenuItem) => void;
  onDismiss: () => void;
}) {
  const insets = useSafeAreaInsets();

  // Choosing and dismissing are separate paths, not one `onClose` — a menu whose
  // result is awaited has to be able to tell "they picked nothing" from "they
  // picked something", and only the first should fire `onCancel`.
  //
  // Both close the sheet *before* anything else happens: the action may navigate
  // or open a confirmation, and leaving a sheet mounted over either is how you
  // get a modal stacked on a modal — which on Android is a dead screen.

  return (
    <Modal
      transparent
      animationType="fade"
      // Android's back button. Without this the press falls through to the
      // navigator and leaves the screen with the sheet still notionally open.
      onRequestClose={onDismiss}
      accessibilityViewIsModal
    >
      <Pressable
        style={styles.backdrop}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss menu"
      >
        {/* Swallow presses on the sheet itself so they don't reach the
            backdrop's dismiss handler. */}
        <Pressable
          testID="action-menu"
          style={[styles.sheet, { paddingBottom: insets.bottom + spacing.sm }]}
          onPress={() => {}}
        >
          {request.title ? (
            <Text style={styles.title}>{request.title}</Text>
          ) : null}

          {request.items.map((item) => (
            <Pressable
              key={item.label}
              // Enumerable by the tests, which drive the *rendered* sheet
              // rather than a captured data structure — the whole point, since
              // the previous seam certified menu items Android never drew.
              testID={
                item.destructive ? 'action-menu-item-destructive' : 'action-menu-item'
              }
              onPress={() => onChoose(item)}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              android_ripple={{ color: colors.line }}
              style={styles.item}
            >
              <Text
                style={[styles.itemLabel, item.destructive && styles.destructive]}
              >
                {item.label}
              </Text>
            </Pressable>
          ))}

          <Pressable
            testID="action-menu-cancel"
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            android_ripple={{ color: colors.line }}
            style={styles.item}
          >
            <Text style={[styles.itemLabel, styles.cancel]}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: spacing.sm,
  },
  title: {
    fontSize: fontSize.sm,
    color: colors.inkSoft,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  item: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  itemLabel: { fontSize: fontSize.base, color: colors.ink },
  destructive: { color: colors.danger },
  cancel: { color: colors.inkSoft },
});
