/**
 * Design tokens, translated from the web app's Tailwind `@theme` block
 * (`frontend/src/index.css`). See docs/design-system.md for the intent behind
 * them — the warm-modern "living line" look.
 *
 * Why a copy rather than a shared package: Tailwind tokens are CSS custom
 * properties, which React Native has no concept of. There is no mechanism that
 * could read them here, so the values are transcribed once. Phase 9's repo-layout
 * decision covers the trade-off (docs/phases/phase-9-iphone-app.md) — extracting
 * a shared package for ~1k lines was judged worse than copying.
 *
 * **If you change a colour here, change it in `frontend/src/index.css` too** (and
 * vice versa), or the two clients drift apart visually.
 */

export const colors = {
  // Neutrals carry a faint warm bias toward the surface — never a flat grey.
  surface: '#fbfaf7', // warm near-white app ground
  raised: '#ffffff', // cards, compose, inputs
  ink: '#1c1a16', // near-black, faint warmth
  inkSoft: '#57534b', // secondary text
  inkFaint: '#928d83', // meta, timestamps
  line: '#ece9e2', // soft hairline
  lineStrong: '#e0dcd3', // input borders
  spine: '#ded9cf', // the timeline line itself

  // One accent only: a modern emerald-teal for connection and growth.
  accent: '#1c8a6a',
  accentDeep: '#146650', // hover / press
  accentTint: '#e6f2ed', // washes: chips, hovers

  // Avatar earth palette — lives in the same world as the surface.
  avClay: '#c06a44',
  avOchre: '#c39433',
  avSage: '#7a8a5c',
  avTeal: '#3e9585',
  avPlum: '#8c6076',
  avMoss: '#5f7a50',

  // Not in the web tokens: RN has no `:invalid` styling, so form errors need an
  // explicit colour. Warm red, chosen to sit in the same palette.
  danger: '#b3402f',
} as const;

/**
 * The web app self-hosts Bricolage Grotesque / Hanken Grotesk (privacy-first: no
 * Google CDN request per visitor). Milestone B deliberately ships with the
 * *system* font instead of bundling those files.
 *
 * Two reasons: the plan says to aim for native-feeling rather than a pixel copy
 * of the web, and San Francisco is what makes an iOS app feel native. Bundling
 * the display face for headings is a deliberate later choice, not an oversight —
 * revisit when the first real screens land in Milestone C.
 */
export const fonts = {
  body: undefined, // system default (San Francisco on iOS, Roboto on Android)
  mono: 'Menlo',
} as const;

/** 4px base scale, matching Tailwind's spacing rhythm. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
} as const;

export const fontSize = {
  sm: 13,
  base: 16,
  lg: 20,
  xl: 28,
} as const;

/**
 * The native date/time picker (`@react-native-community/datetimepicker`) renders
 * its own wheel and doesn't read our tokens, so it has to be told two things
 * directly — kept here as the single source both poll pickers share.
 *
 * `pickerHeight`: the inline iOS spinner reports a tiny intrinsic size and
 * collapses inside a nested flex layout, so it needs an explicit height to draw
 * into (paired with `alignSelf: 'stretch'` for width).
 *
 * `pickerThemeVariant`: forces the wheel's luminance. The app surface is always
 * light (there is no dark theme — see `colors` above), so the wheel is too;
 * without this its numbers go invisible when the OS is in dark mode. If a dark
 * theme ever lands, this is the one place to make the picker follow it.
 */
export const pickerHeight = 216;
export const pickerThemeVariant = 'light' as const;
