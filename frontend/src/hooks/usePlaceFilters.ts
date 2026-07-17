import { useDeferredValue, useMemo, useState } from 'react';
import { defaultSiteFilterState } from '../constants';
import { normalizeSiteSourceType, uniqueSorted } from '../lib/sites';
import type { ListScope, Place, PlaceType, SiteFilterState } from '../types';

export const MAX_VISIBLE_LIST_ITEMS = 500;

type UsePlaceFiltersOptions = {
  places: Record<PlaceType, Place[]>;
  sortedPlaces: Record<PlaceType, Place[]>;
  placeSearchTextByType: Record<PlaceType, Map<string, string>>;
  visitedIds: Set<string>;
  visitedCountryCodes: Set<string>;
  airportAutocomplete: (input: string) => Place[];
};

/**
 * Sidebar list state: active tab, per-type search, scope filters, site
 * filters, visited-country filters, and the resulting filtered place list.
 */
export function usePlaceFilters({
  places,
  sortedPlaces,
  placeSearchTextByType,
  visitedIds,
  visitedCountryCodes,
  airportAutocomplete,
}: UsePlaceFiltersOptions) {
  const [activeTab, setActiveTab] = useState<PlaceType>('country');
  const [search, setSearch] = useState<Record<PlaceType, string>>({
    country: '',
    state: '',
    city: '',
    airport: '',
    site: '',
  });
  const [selectedAirportSearchId, setSelectedAirportSearchId] = useState('');
  const [listScope, setListScope] = useState<Record<PlaceType, ListScope>>({
    country: 'all',
    state: 'all',
    city: 'all',
    airport: 'all',
    site: 'all',
  });
  const [siteFilters, setSiteFilters] = useState<SiteFilterState>(defaultSiteFilterState);
  const [selectedVisitedCountries, setSelectedVisitedCountries] = useState<Record<'state' | 'city', string[]>>({
    state: [],
    city: [],
  });
  const deferredSearch = useDeferredValue(search);

  const siteCategories = useMemo(() => {
    const selectedSource = siteFilters.sourceType;
    return [
      'all',
      ...uniqueSorted(
        places.site
          .filter((site) => selectedSource === 'all' || normalizeSiteSourceType(site.sourceType) === selectedSource)
          .map((site) => site.type || site.category)
          .map((value) => value?.toLowerCase()),
      ),
    ];
  }, [places.site, siteFilters.sourceType]);

  const airportAutocompleteOptions = useMemo(() => {
    return airportAutocomplete(deferredSearch.airport);
  }, [airportAutocomplete, deferredSearch.airport]);

  const getScopeOptions = (type: PlaceType) => {
    const options: Array<{ value: ListScope; label: string }> = [
      { value: 'all', label: 'All' },
      { value: 'visited', label: 'Visited' },
      { value: 'unvisited', label: 'Unvisited' },
    ];
    if (type === 'site') {
      options.push({ value: 'visited_countries', label: 'In visited countries' });
    }
    return options;
  };

  const visitedCountryScopeOptions = useMemo(() => {
    const options = sortedPlaces.country
      .filter((country) => country.country_code && visitedCountryCodes.has(country.country_code.toUpperCase()))
      .map((country) => ({
        code: (country.country_code || '').toUpperCase(),
        label: country.name,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return options;
  }, [sortedPlaces.country, visitedCountryCodes]);

  const activeFilteredPlaces = useMemo(() => {
    const term = deferredSearch[activeTab].trim().toLowerCase();
    let scopedPlaces = sortedPlaces[activeTab];

    if (activeTab === 'state' || activeTab === 'city') {
      const selectedCodes = selectedVisitedCountries[activeTab];
      if (selectedCodes.length > 0) {
        const selectedCodeSet = new Set(selectedCodes);
        scopedPlaces = scopedPlaces.filter((place) => selectedCodeSet.has((place.country_code || '').toUpperCase()));
      }
    }

    const filtered = scopedPlaces
      .filter((place) => {
        if (activeTab !== 'site') return true;
        const sourceType = normalizeSiteSourceType(place.sourceType);
        const sourceCountrySet = new Set((place.countryOrCountries ?? []).map((value) => value.toLowerCase()));
        return (
          (siteFilters.sourceType === 'all' || sourceType === siteFilters.sourceType) &&
          (siteFilters.category === 'all' || (place.type || place.category || '').trim().toLowerCase() === siteFilters.category) &&
          (siteFilters.country === 'all' || sourceCountrySet.has(siteFilters.country))
        );
      })
      .filter((place) => {
        if (activeTab === 'airport') {
          if (selectedAirportSearchId) {
            return place.id === selectedAirportSearchId;
          }
        }
        return (placeSearchTextByType[activeTab].get(place.id) ?? '').includes(term);
      })
      .filter((place) => {
        const isVisited = visitedIds.has(place.id);
        if (listScope[activeTab] === 'visited') return isVisited;
        if (listScope[activeTab] === 'unvisited') return !isVisited;
        if (activeTab === 'site' && listScope[activeTab] === 'visited_countries') {
          return visitedCountryCodes.has((place.country_code || '').toUpperCase());
        }
        return true;
      });

    return filtered;
  }, [
    activeTab,
    deferredSearch,
    listScope,
    placeSearchTextByType,
    selectedVisitedCountries,
    selectedAirportSearchId,
    visitedCountryCodes,
    siteFilters,
    sortedPlaces,
    visitedIds,
  ]);

  const visiblePlaces = useMemo(
    () => activeFilteredPlaces.slice(0, MAX_VISIBLE_LIST_ITEMS),
    [activeFilteredPlaces],
  );

  const onToggleVisitedCountrySelection = (tab: 'state' | 'city', code: string) => {
    setSelectedVisitedCountries((prev) => {
      const current = prev[tab];
      const next = current.includes(code) ? current.filter((value) => value !== code) : [...current, code];
      return { ...prev, [tab]: next };
    });
  };

  const updateSiteSourceFilter = (sourceType: string) => {
    setSiteFilters((prev) => ({
      ...prev,
      sourceType,
      category: 'all',
    }));
  };

  return {
    activeTab,
    setActiveTab,
    search,
    setSearch,
    deferredSearch,
    selectedAirportSearchId,
    setSelectedAirportSearchId,
    listScope,
    setListScope,
    siteFilters,
    setSiteFilters,
    selectedVisitedCountries,
    setSelectedVisitedCountries,
    siteCategories,
    airportAutocompleteOptions,
    getScopeOptions,
    visitedCountryScopeOptions,
    activeFilteredPlaces,
    visiblePlaces,
    onToggleVisitedCountrySelection,
    updateSiteSourceFilter,
  };
}
