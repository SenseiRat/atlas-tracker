import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { tabs } from '../constants';
import { uniqueSorted } from '../lib/sites';
import type { Place, PlacesResponse, PlaceType } from '../types';

type UsePlacesOptions = {
  enabled: boolean;
  setUiError: (message: string | null) => void;
};

/**
 * Loads every place list once and exposes the derived lookups (sorted lists,
 * search text, airport code/label maps, country/state name maps).
 */
export function usePlaces({ enabled, setUiError }: UsePlacesOptions) {
  const [places, setPlaces] = useState<Record<PlaceType, Place[]>>({
    country: [],
    state: [],
    city: [],
    airport: [],
    site: [],
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const loadAllPlaces = async (tab: (typeof tabs)[number]): Promise<Place[]> => {
      const airportParam = tab.type === 'airport' ? '&major_only=true' : '';
      const pageSizeByType: Record<PlaceType, number> = {
        country: 500,
        state: 10000,
        city: 10000,
        airport: 5000,
        site: 3000,
      };
      const pageSize = pageSizeByType[tab.type];
      let offset = 0;
      let hasMore = true;
      const allItems: Place[] = [];

      while (hasMore) {
        const response = await api<PlacesResponse>(
          `/api/places?type=${tab.type}&limit=${pageSize}&offset=${offset}&include_total=false${airportParam}`,
          { signal: controller.signal },
        );
        allItems.push(...response.items);
        if (response.items.length === 0) break;
        offset = typeof response.next_offset === 'number' ? response.next_offset : offset + response.items.length;
        hasMore = Boolean(response.has_more);
      }

      return allItems;
    };

    Promise.all(
      tabs.map(async (tab) => {
        const items = await loadAllPlaces(tab);
        return [tab.type, items] as const;
      }),
    )
      .then((entries) => {
        if (controller.signal.aborted) return;
        setPlaces(
          entries.reduce(
            (acc, [type, items]) => {
              acc[type] = items;
              return acc;
            },
            {
              country: [],
              state: [],
              city: [],
              airport: [],
              site: [],
            } as Record<PlaceType, Place[]>,
          ),
        );
      })
      .catch((error) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setUiError('Unable to load place lists.');
      });
    return () => {
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

  const siteCountries = useMemo(
    () => ['all', ...uniqueSorted(places.site.flatMap((site) => site.countryOrCountries ?? []))],
    [places.site],
  );

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
    sortedPlaces,
    placeSearchTextByType,
    airportOptions,
    airportLabelById,
    airportIdByLabel,
    airportIdByCode,
    airportAutocomplete,
    resolveAirportId,
    siteCountries,
    countryNameByCode,
    stateNameByCountryAndCode,
    pointLookup,
  };
}
