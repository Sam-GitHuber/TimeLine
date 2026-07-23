/**
 * The practical planner: a conventional month grid. Each event sits **in its day
 * cell** as a small titled chip — accent when scheduled, muted when it's already
 * happened, struck through when cancelled; today is ringed. A busy day shows the
 * first few and a "+N more" that expands the full day's list beneath the grid.
 *
 * `events` is the group/personal calendar window (dated events only) — it fetches
 * nothing itself, the screen hands it the events. Ported from
 * `frontend/src/components/events/MonthGrid.jsx`; Monday-first, like the web.
 */

import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatEventTime, parseEventDate } from '@/eventFormat';
import { colors, fontSize, fonts, spacing } from '@/theme';
import type { Event } from '@/types';

const MAX_PER_DAY = 3;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function MonthGrid({ events = [] }: { events?: Event[] }) {
  const [cursor, setCursor] = useState(() => startOfMonth(firstEventDate(events)));
  const [openDay, setOpenDay] = useState<string | null>(null);

  const byDay = useMemo(() => groupByDay(events), [events]);
  const todayKey = dayKeyLocal(new Date());
  const cells = useMemo(() => monthCells(cursor), [cursor]);
  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <View>
      <View style={styles.header}>
        <Pressable
          onPress={() => setCursor(addMonths(cursor, -1))}
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          hitSlop={8}
          style={styles.navBtn}
        >
          <Text style={styles.navText}>←</Text>
        </Pressable>
        <Text style={styles.monthLabel}>{monthLabel}</Text>
        <Pressable
          onPress={() => setCursor(addMonths(cursor, 1))}
          accessibilityRole="button"
          accessibilityLabel="Next month"
          hitSlop={8}
          style={styles.navBtn}
        >
          <Text style={styles.navText}>→</Text>
        </Pressable>
      </View>

      <View style={styles.weekRow}>
        {WEEKDAYS.map((d) => (
          <Text key={d} style={styles.weekday}>
            {d}
          </Text>
        ))}
      </View>

      <View style={styles.grid}>
        {cells.map((day, i) => {
          if (!day) return <View key={i} style={styles.cell} />;
          const key = dayKeyLocal(day);
          const dayEvents = byDay.get(key) ?? [];
          const shown = dayEvents.slice(0, MAX_PER_DAY);
          const extra = dayEvents.length - shown.length;
          const isToday = key === todayKey;
          return (
            <View key={i} style={[styles.cell, isToday && styles.cellToday]}>
              <Text style={[styles.dayNum, isToday && styles.dayNumToday]}>{day.getDate()}</Text>
              {shown.map((e) => (
                <Pressable
                  key={e.id}
                  onPress={() => router.push(`/events/${e.id}`)}
                  accessibilityRole="button"
                  style={[styles.chip, chipStyle(e)]}
                >
                  <Text style={[styles.chipText, chipTextStyle(e)]} numberOfLines={1}>
                    {formatEventTime(e.start_time) ? `${formatEventTime(e.start_time)} ` : ''}
                    {e.title}
                  </Text>
                </Pressable>
              ))}
              {extra > 0 ? (
                <Pressable
                  onPress={() => setOpenDay(openDay === key ? null : key)}
                  accessibilityRole="button"
                  hitSlop={4}
                >
                  <Text style={styles.more}>+{extra} more</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </View>

      {openDay && (byDay.get(openDay)?.length ?? 0) > 0 ? (
        <View style={styles.dayList}>
          {(byDay.get(openDay) ?? []).map((e) => (
            <Pressable
              key={e.id}
              onPress={() => router.push(`/events/${e.id}`)}
              accessibilityRole="button"
              style={styles.dayListRow}
            >
              <Text style={styles.dayListTime}>{formatEventTime(e.start_time) || 'all day'}</Text>
              <Text style={styles.dayListTitle} numberOfLines={1}>
                {e.title}
              </Text>
              <Text style={styles.dayListGroup} numberOfLines={1}>
                {e.group.name}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function chipStyle(e: Event) {
  if (e.status === 'cancelled') return styles.chipOff;
  if (e.is_past) return styles.chipPast;
  return styles.chipScheduled;
}

function chipTextStyle(e: Event) {
  if (e.status === 'cancelled') return styles.chipTextOff;
  if (e.is_past) return styles.chipTextPast;
  return styles.chipTextScheduled;
}

function groupByDay(events: Event[]): Map<string, Event[]> {
  const map = new Map<string, Event[]>();
  for (const e of events) {
    const d = parseEventDate(e.event_date);
    if (!d) continue;
    const key = dayKeyLocal(d);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(e);
  }
  return map;
}

function firstEventDate(events: Event[]): Date {
  const upcoming = events.find((e) => !e.is_past);
  const d = parseEventDate((upcoming ?? events[0])?.event_date);
  return d ?? new Date();
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

// A flat Monday-first array of Date cells for the month, null for padding.
function monthCells(monthStart: Date): (Date | null)[] {
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // Monday = 0
  const cells: (Date | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function dayKeyLocal(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  navBtn: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  navText: { fontSize: fontSize.lg, color: colors.accent, fontWeight: '600' },
  monthLabel: { fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
  weekRow: { flexDirection: 'row' },
  weekday: {
    width: `${100 / 7}%`,
    textAlign: 'center',
    fontSize: 10,
    fontWeight: '700',
    color: colors.inkFaint,
    textTransform: 'uppercase',
    paddingVertical: spacing.xs,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: `${100 / 7}%`,
    minHeight: 64,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    padding: 2,
    gap: 2,
  },
  cellToday: { backgroundColor: colors.accentTint },
  dayNum: { fontFamily: fonts.mono, fontSize: 10, color: colors.inkFaint, textAlign: 'right' },
  dayNumToday: { color: colors.accentDeep, fontWeight: '700' },
  chip: { borderRadius: 3, paddingHorizontal: 2, paddingVertical: 1 },
  chipScheduled: { backgroundColor: colors.accentTint },
  chipPast: { backgroundColor: colors.line },
  chipOff: { backgroundColor: colors.line },
  chipText: { fontSize: 9 },
  chipTextScheduled: { color: colors.accentDeep, fontWeight: '600' },
  chipTextPast: { color: colors.inkFaint },
  chipTextOff: { color: colors.inkFaint, textDecorationLine: 'line-through' },
  more: { fontSize: 9, color: colors.inkFaint, fontWeight: '600' },
  dayList: {
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  dayListRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, paddingVertical: spacing.xs },
  dayListTime: { fontFamily: fonts.mono, fontSize: 11, color: colors.inkFaint },
  dayListTitle: { fontSize: fontSize.sm, color: colors.ink, flexShrink: 1 },
  dayListGroup: { fontSize: 11, fontStyle: 'italic', color: colors.inkFaint },
});
