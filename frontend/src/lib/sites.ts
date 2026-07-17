import type { Place, SiteSourceType, ThemeMode } from '../types';

export const siteSourceRegistry: Record<
  SiteSourceType,
  {
    label: string;
    badge: string;
    markerKind: 'site' | 'festival';
    themeColor: Record<ThemeMode, string>;
    recurringLabel?: string;
  }
> = {
  unesco: {
    label: 'UNESCO',
    badge: 'UNESCO',
    markerKind: 'site',
    themeColor: {
      dark: '#a78bfa',
      light: '#7c3aed',
    },
  },
  dark_sky: {
    label: 'Dark Sky',
    badge: 'Dark Sky',
    markerKind: 'site',
    themeColor: {
      dark: '#38bdf8',
      light: '#0f766e',
    },
  },
  festival: {
    label: 'Festival',
    badge: 'Festival',
    markerKind: 'festival',
    themeColor: {
      dark: '#f59e0b',
      light: '#c2410c',
    },
    recurringLabel: 'Recurring cultural event',
  },
  michelin: {
    label: 'Michelin',
    badge: 'Michelin',
    markerKind: 'site',
    themeColor: {
      dark: '#fb7185',
      light: '#be123c',
    },
  },
};

export function normalizeSiteSourceType(value?: string | null): SiteSourceType {
  if (value === 'dark_sky' || value === 'festival' || value === 'unesco' || value === 'michelin') return value;
  return 'unesco';
}

export function uniqueSorted(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => (value ?? '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

export function coerceBooleanMetadata(value: unknown) {
  return value === true;
}

export function getSiteSourceConfig(place: Place) {
  return siteSourceRegistry[normalizeSiteSourceType(place.sourceType)];
}

export function getSiteMetadataValue(place: Place, key: string) {
  return place.metadata?.[key];
}
