import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { readCachedPlaces, writeCachedPlaces } from '../lib/placesCache';
import { getSiteCountryKeys } from '../lib/sites';
import type { Place, PlacesResponse, PlaceType } from '../types';

type UsePlacesOptions = {
  enabled: boolean;
  setUiError: (message: string | null) => void;
};

const emptyPlaces = (): Record<PlaceType, Place[]> => ({
  country: [],
  state: [],
  city: [],
  airport: [],
  site: [],
});

// Loaded smallest-first so the fast lists (countries, states) paint almost
// immediately instead of waiting behind the ~33k-row city download.
const loadOrder: PlaceType[] = ['country', 'state', 'airport', 'site', 'city'];

/**
 * Loads every place list once and exposes the derived lookups (sorted lists,
 * search text, airport code/label maps, country/state name maps).
 *
 * Loading is progressive and cache-first: each type is painted the moment its
 * data is available — first from the IndexedDB cache of the previous session,
 * then overwritten by a fresh network fetch (stale-while-revalidate). This
 * replaces the old all-or-nothing load that left every list blank until the
 * slowest one (cities) finished.
 */
export function usePlaces({ enabled, setUiError }: UsePlacesOptions) {
  const [places, setPlaces] = useState<Record<PlaceType, Place[]>>(emptyPlaces);
  // A type is "loading" until it has data from either the cache or the network
  // (or a network fetch completes empty). Drives per-list loading skeletons.
  const [placesLoading, setPlacesLoading] = useState<Record<PlaceType, boolean>>({
    country: true,
    state: true,
    city: true,
    airport: true,
    site: true,
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;

    const setType = (type: PlaceType, items: Place[]) => {
      if (!active) return;
      setPlaces((prev) => ({ ...prev, [type]: items }));
      setPlacesLoading((prev) => (prev[type] ? { ...prev, [type]: false } : prev));
    };

    const loadAllPlaces = async (type: PlaceType): Promise<Place[]> => {
      const airportParam = type === 'airport' ? '&major_only=true' : '';
      const pageSizeByType: Record<PlaceType, number> = {
        country: 500,
        state: 10000,
        city: 20000,
        airport: 5000,
        site: 3000,
      };
      const pageSize = pageSizeByType[type];
      let offset = 0;
      let hasMore = true;
      const allItems: Place[] = [];

      while (hasMore) {
        const response = await api<PlacesResponse>(
          `/api/places?type=${type}&limit=${pageSize}&offset=${offset}&include_total=false${airportParam}`,
          { signal: controller.signal },
        );
        allItems.push(...response.items);
        if (response.items.length === 0) break;
        offset = typeof response.next_offset === 'number' ? response.next_offset : offset + response.items.length;
        hasMore = Boolean(response.has_more);
      }

      return allItems;
    };

    // Paint from the persisted cache first (fast, may be slightly stale). Only
    // fills a type the network hasn't already delivered for this session.
    const hydrated = new Set<PlaceType>();
    loadOrder.forEach((type) => {
      readCachedPlaces(type).then((cached) => {
        if (!active || !cached || !cached.length) return;
        if (hydrated.has(type)) return;
        hydrated.add(type);
        setType(type, cached);
      });
    });

    // Fetch fresh in parallel; each type replaces its cache-hydrated list as
    // soon as it arrives and is written back to the cache for next time.
    loadOrder.forEach((type) => {
      loadAllPlaces(type)
        .then((items) => {
          if (!active) return;
          hydrated.add(type);
          setType(type, items);
          void writeCachedPlaces(type, items);
        })
        .catch((error) => {
          if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
          setUiError('Unable to load place lists.');
        });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled]);

  const sortedPlaces = useMemo<Record<PlaceType, Place[]>>(
    () => ({
      country: [...places.country].sort((a, b) => a.name.localeCompare(b.name)),
      state: [...places.state].sort((a, b) => a.name.localeCompare(b.name)),
      city: [...places.city].sort((a, b) => a.name.localeCompare(b.name)),
      airport: [...places.airport].sort((a, b) => a.name.localeCompare(b.name)),
      site: [...places.site].sort((a, b) => a.name.localeCompare(b.name)),
    }),
    [places],
  );

  const placeSearchTextByType = useMemo<Record<PlaceType, Map<string, string>>>(() => {
    const buildSearchText = (type: PlaceType, place: Place) => {
      if (type === 'state') {
        const fallbackState = place.state_code || place.id.replace(/^state-[^-]+-/, '') || '';
        return `${place.name || fallbackState} ${place.country_code || ''}`.toLowerCase();
      }
      if (type === 'airport') {
        return `${place.name} ${place.airport_code ?? ''} ${place.search_location ?? ''}`.toLowerCase();
      }
      if (type === 'site') {
        return [
          place.name,
          ...(place.alternateNames ?? []),
          place.cityOrLocality,
          ...(place.countryOrCountries ?? []),
          ...(place.tags ?? []),
          place.summary,
          place.region,
          place.type,
          place.category,
          place.sourceType,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
      }
      return place.name.toLowerCase();
    };

    return {
      country: new Map(sortedPlaces.country.map((place) => [place.id, buildSearchText('country', place)])),
      state: new Map(sortedPlaces.state.map((place) => [place.id, buildSearchText('state', place)])),
      city: new Map(sortedPlaces.city.map((place) => [place.id, buildSearchText('city', place)])),
      airport: new Map(sortedPlaces.airport.map((place) => [place.id, buildSearchText('airport', place)])),
      site: new Map(sortedPlaces.site.map((place) => [place.id, buildSearchText('site', place)])),
    };
  }, [sortedPlaces]);

  const airportOptions = useMemo(() => {
    return [...sortedPlaces.airport]
      .filter((airport) => Boolean(airport.airport_code))
      .sort((a, b) => {
        const aa = `${a.name} ${a.airport_code ?? ''}`;
        const bb = `${b.name} ${b.airport_code ?? ''}`;
        return aa.localeCompare(bb);
      });
  }, [sortedPlaces.airport]);

  const airportLabelById = useMemo(() => {
    const map = new Map<string, string>();
    airportOptions.forEach((airport) => {
      map.set(airport.id, `${airport.name} (${airport.airport_code})`);
    });
    return map;
  }, [airportOptions]);

  const airportIdByLabel = useMemo(() => {
    const map = new Map<string, string>();
    airportLabelById.forEach((label, id) => map.set(label, id));
    return map;
  }, [airportLabelById]);

  const airportIdByCode = useMemo(() => {
    const map = new Map<string, string>();
    airportOptions.forEach((airport) => {
      const code = airport.airport_code?.toUpperCase();
      if (code && !map.has(code)) {
        map.set(code, airport.id);
      }
    });
    return map;
  }, [airportOptions]);

  const airportAutocomplete = useCallback((input: string) => {
    const normalized = input.trim().toLowerCase();
    if (!normalized) return airportOptions.slice(0, 60);
    return airportOptions
      .filter((airport) => (placeSearchTextByType.airport.get(airport.id) ?? '').includes(normalized))
      .slice(0, 60);
  }, [airportOptions, placeSearchTextByType]);

  const resolveAirportId = (value: string) => {
    const input = value.trim();
    if (!input) return '';

    const labelMatch = airportIdByLabel.get(input);
    if (labelMatch) return labelMatch;

    const codeMatch = input.match(/\(([A-Za-z]{3})\)$/);
    if (codeMatch) {
      return airportIdByCode.get(codeMatch[1].toUpperCase()) ?? '';
    }
    return airportIdByCode.get(input.toUpperCase()) ?? '';
  };

  const countryNameByCode = useMemo(() => {
    const map = new Map<string, string>();
    places.country.forEach((country) => {
      const code = (country.country_code || '').trim().toUpperCase();
      const name = country.name?.trim();
      if (code && name) {
        map.set(code, name);
      }
    });
    return map;
  }, [places.country]);

  const countryCodeByName = useMemo(() => {
    const map = new Map<string, string>();
    places.country.forEach((country) => {
      const code = (country.country_code || '').trim().toUpperCase();
      const name = country.name?.trim().toLowerCase();
      if (code && name && !map.has(name)) {
        map.set(name, code);
      }
    });
    return map;
  }, [places.country]);

  // Every country a site belongs to, deduped across the mixed name/ISO-code
  // spellings in the site datasets, labeled with the proper country name.
  const siteCountryOptions = useMemo(() => {
    const labelByKey = new Map<string, string>();
    places.site.forEach((site) => {
      getSiteCountryKeys(site, countryCodeByName, countryNameByCode).forEach((key) => {
        if (labelByKey.has(key)) return;
        labelByKey.set(key, countryNameByCode.get(key) ?? (key === key.toUpperCase() ? key : key.replace(/\b\w/g, (c) => c.toUpperCase())));
      });
    });
    return Array.from(labelByKey.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [places.site, countryCodeByName, countryNameByCode]);

  const stateNameByCountryAndCode = useMemo(() => {
    const map = new Map<string, string>();
    places.state.forEach((state) => {
      const countryCode = (state.country_code || '').trim().toUpperCase();
      const stateCode = (state.state_code || '').trim().toUpperCase();
      const stateName = state.name?.trim();
      if (countryCode && stateCode && stateName) {
        map.set(`${countryCode}:${stateCode}`, stateName);
      }
    });
    return map;
  }, [places.state]);

  const pointLookup = useMemo(
    () => new Map([...places.city, ...places.airport, ...places.site].map((place) => [place.id, place] as const)),
    [places.city, places.airport, places.site],
  );

  return {
    places,
    placesLoading,
    sortedPlaces,
    placeSearchTextByType,
    airportOptions,
    airportLabelById,
    airportIdByLabel,
    airportIdByCode,
    airportAutocomplete,
    resolveAirportId,
    siteCountryOptions,
    countryNameByCode,
    countryCodeByName,
    stateNameByCountryAndCode,
    pointLookup,
  };
}
