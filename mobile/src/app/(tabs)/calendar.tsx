/**
 * The personal Calendar tab — everything upcoming across the groups you're in,
 * each event labelled with its group. Deliberately its own surface, not merged
 * into the feed: groups stay in groups by default; this is the opt-in aggregate,
 * the same discipline as the `include_groups` feed toggle (events.md, decision 4).
 *
 * The fifth tab (the confirmed E3 nav decision — five is the iOS comfortable
 * max). An **Agenda / Month** toggle swaps a chronological list of `EventCard`s
 * for the `MonthGrid`. Ported from `frontend/src/pages/CalendarPage.jsx`.
 */

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { api } from '@/api';
import { EventCard } from '@/components/events/EventCard';
import { MonthGrid } from '@/components/events/MonthGrid';
import { colors, fontSize, radius, spacing } from '@/theme';

export default function CalendarScreen() {
  const [view, setView] = useState<'agenda' | 'month'>('agenda');

  const calendar = useQuery({
    queryKey: ['personalCalendar'],
    queryFn: () => api.getPersonalCalendar(),
  });
  const events = calendar.data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Calendar</Text>
        <View style={styles.toggle} accessibilityLabel="Calendar view">
          <Pressable
            onPress={() => setView('agenda')}
            accessibilityRole="button"
            accessibilityState={{ selected: view === 'agenda' }}
            style={[styles.toggleBtn, view === 'agenda' && styles.toggleOn]}
          >
            <Text style={[styles.toggleText, view === 'agenda' && styles.toggleTextOn]}>Agenda</Text>
          </Pressable>
          <Pressable
            onPress={() => setView('month')}
            accessibilityRole="button"
            accessibilityState={{ selected: view === 'month' }}
            style={[styles.toggleBtn, view === 'month' && styles.toggleOn]}
          >
            <Text style={[styles.toggleText, view === 'month' && styles.toggleTextOn]}>Month</Text>
          </Pressable>
        </View>
      </View>

      {calendar.isLoading ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : events.length === 0 ? (
        <View style={styles.centre}>
          <Text style={styles.emptyBody}>
            Nothing on the calendar. When a group plans an event, it shows up here.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {view === 'agenda' ? (
            events.map((e) => <EventCard key={e.id} event={e} showGroup />)
          ) : (
            <MonthGrid events={events} />
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  title: { fontSize: fontSize.xl, fontWeight: '700', color: colors.ink },
  toggle: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  toggleBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  toggleOn: { backgroundColor: colors.accent },
  toggleText: { fontSize: fontSize.sm, fontWeight: '600', color: colors.inkSoft },
  toggleTextOn: { color: colors.raised },
  spinner: { marginTop: spacing.xl },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyBody: { fontSize: fontSize.sm, color: colors.inkSoft, textAlign: 'center', lineHeight: 20 },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xxl },
});
