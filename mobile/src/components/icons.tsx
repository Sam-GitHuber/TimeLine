/**
 * Line-style tab-bar icons, drawn with `react-native-svg` (already a dependency,
 * so no new icon library — see the E1 nav decision).
 *
 * They're hand-drawn rather than pulled from an icon set on purpose: the feed
 * glyph is the app's own timeline spine (a vertical line with beads and entries
 * hanging off it), which no stock icon carries. Stroke weight and the round caps
 * match the warm-modern "living line" look (docs/design-system.md).
 *
 * Each takes `color` + `size` so the tab bar can tint it (accent when focused,
 * faint ink otherwise) — the same contract `tabBarIcon` hands us.
 */

import Svg, { Circle, Line, Path } from 'react-native-svg';

type IconProps = { color: string; size?: number };

/** The timeline: a spine with two beads and the entries hanging off it. */
export function FeedIcon({ color, size = 26 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Line
        x1={6}
        y1={4}
        x2={6}
        y2={20}
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
      />
      <Circle cx={6} cy={9} r={2} fill={color} />
      <Circle cx={6} cy={15} r={2} fill={color} />
      <Line
        x1={11}
        y1={9}
        x2={20}
        y2={9}
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
      />
      <Line
        x1={11}
        y1={15}
        x2={18}
        y2={15}
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Two people — the connection graph. */
export function PeopleIcon({ color, size = 26 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={9} cy={8} r={3.25} stroke={color} strokeWidth={1.75} />
      <Path
        d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M16 6.2a3 3 0 0 1 0 5.6"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M17 14.2c2.3.5 3.9 2.3 3.9 4.8"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
