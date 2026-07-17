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

const COUNTRY_CODE_RE = /^[A-Za-z]{2,3}$/;

/**
 * Canonical country keys for a site. Site datasets mix full country names
 * (UNESCO, festivals) with bare ISO codes (dark sky, Michelin fallbacks);
 * resolving both to ISO codes lets the country filter treat "France" and
 * "FRA" as the same country. Codes that don't match a known country (e.g.
 * UNESCO's raw ISO-2 secondary codes) are dropped rather than surfaced as
 * bare abbreviations; unresolvable names fall back to their lowercased text.
 */
export function getSiteCountryKeys(
  place: Place,
  countryCodeByName: Map<string, string>,
  countryNameByCode: Map<string, string>,
): Set<string> {
  const keys = new Set<string>();
  const addCode = (value?: string | null) => {
    const code = (value ?? '').trim().toUpperCase();
    if (COUNTRY_CODE_RE.test(code) && countryNameByCode.has(code)) keys.add(code);
  };
  addCode(place.country_code);
  (place.country_codes ?? []).forEach(addCode);
  (place.countryOrCountries ?? []).forEach((entry) => {
    const text = (entry ?? '').trim();
    if (!text) return;
    if (COUNTRY_CODE_RE.test(text)) {
      addCode(text);
      return;
    }
    const resolved = countryCodeByName.get(text.toLowerCase());
    if (resolved) keys.add(resolved);
    else keys.add(text.toLowerCase());
  });
  return keys;
}
