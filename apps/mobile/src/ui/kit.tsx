import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, useColorScheme, View, type TextInputProps, type ViewStyle } from 'react-native';
import type { Status } from '@huddle/core';

const light = {
  bg: '#F7F5FB',
  card: '#FFFFFF',
  text: '#16121F',
  muted: '#6B6478',
  line: '#E6E1EE',
  accent: '#6A4CF5',
  ok: '#14855B',
  warn: '#B86E00',
  danger: '#C8282E',
  info: '#2F6FD6',
};
const dark: typeof light = {
  bg: '#0F0C17',
  card: '#1A1624',
  text: '#F3F0FA',
  muted: '#A49DB3',
  line: '#2C263A',
  accent: '#9B85FF',
  ok: '#3CCB8E',
  warn: '#F2A93B',
  danger: '#FF5A5F',
  info: '#6FA3FF',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export function statusColor(t: Theme, s: Status): string {
  return s === 'ok' ? t.ok : s === 'due' ? t.warn : s === 'left' ? t.muted : s === 'overdue' ? t.warn : t.danger;
}

export const STATUS_LABEL: Record<Status, string> = {
  ok: 'Okay',
  due: 'Check-in due',
  overdue: 'Unreachable',
  escalated: 'Contacts texted',
  sos: 'Asked for help',
  left: 'Left',
};

export function Screen({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[{ flex: 1, backgroundColor: t.bg, padding: 16, gap: 12 }, style]}>{children}</View>;
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return (
    <View style={[{ backgroundColor: t.card, borderRadius: 16, padding: 16, gap: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line }, style]}>
      {children}
    </View>
  );
}

export function H({ children, size = 22 }: { children: ReactNode; size?: number }) {
  const t = useTheme();
  return <Text style={{ color: t.text, fontSize: size, fontWeight: '700' }}>{children}</Text>;
}

export function P({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: object }) {
  const t = useTheme();
  return <Text style={[{ color: muted ? t.muted : t.text, fontSize: 15, lineHeight: 21 }, style]}>{children}</Text>;
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  busy,
  disabled,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'ok';
  busy?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const bg = kind === 'secondary' ? 'transparent' : kind === 'danger' ? t.danger : kind === 'ok' ? t.ok : t.accent;
  const fg = kind === 'secondary' ? t.accent : '#FFFFFF';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderRadius: 12,
          paddingVertical: 14,
          paddingHorizontal: 16,
          alignItems: 'center',
          borderWidth: kind === 'secondary' ? 1 : 0,
          borderColor: t.accent,
          opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontSize: 16, fontWeight: '600' }}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: t.muted, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      <TextInput
        placeholderTextColor={t.muted}
        {...props}
        style={[{ color: t.text, backgroundColor: t.card, borderColor: t.line, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16 }, props.style]}
      />
    </View>
  );
}

export function Pill({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ backgroundColor: color + '22', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' }}>
      <Text style={{ color, fontSize: 12, fontWeight: '700' }}>{label}</Text>
    </View>
  );
}

export function ago(t: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

export function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
