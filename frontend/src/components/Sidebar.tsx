import type { ActiveProfile, Place, PlaceType, ListScope, SiteSourceType } from '../types';
import { tabs } from '../constants';
import { siteSourceRegistry, coerceBooleanMetadata, getSiteMetadataValue, getSiteSourceConfig } from '../lib/sites';
import { formatRegionLabel, formatSiteCategoryLabel } from '../lib/format';
import { usePlaceFilters, MAX_VISIBLE_LIST_ITEMS } from '../hooks/usePlaceFilters';
import { MultiSelectDropdown } from './ui/MultiSelectDropdown';

type SidebarProps = {
  filters: ReturnType<typeof usePlaceFilters>;
  placesLoading: Record<PlaceType, boolean>;
  visitedIds: Set<string>;
  profileId: ActiveProfile;
  canEditSelectedProfile: boolean;
  onToggleVisit: (place: Place) => void;
  focusOnPlace: (place: Place) => void;
  airportLabelById: Map<string, string>;
  resolveAirportId: (value: string) => string;
  siteCountryOptions: Array<{ value: string; label: string }>;
  countryNameByCode: Map<string, string>;
  stateNameByCountryAndCode: Map<string, string>;
};

/** Sidebar: place-type tabs, search/scope/site filters, and the place list. */
export function Sidebar({
  filters,
  placesLoading,
  visitedIds,
  profileId,
  canEditSelectedProfile,
  onToggleVisit,
  focusOnPlace,
  airportLabelById,
  resolveAirportId,
  siteCountryOptions,
  countryNameByCode,
  stateNameByCountryAndCode,
}: SidebarProps) {
  const {
    activeTab,
    setActiveTab,
    search,
    setSearch,
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
  } = filters;

  const formatPlaceLabel = (place: Place, type: PlaceType) => {
    const countryName = place.country_code ? countryNameByCode.get(place.country_code.toUpperCase()) ?? place.country_code : '';
    const regionName = getRegionName(place);
    if (type === 'state') {
      const stateName = place.name?.trim() || place.state_code || place.id.replace(/^state-[^-]+-/, '') || 'Unknown';
      if (countryName) return `${stateName}, ${countryName}`;
      return stateName;
    }
    if (type === 'city') {
      const parts = [place.name];
      if (regionName) parts.push(regionName);
      if (countryName) parts.push(countryName);
      return parts.join(', ');
    }
    if (type === 'airport') {
      const code = place.airport_code ?? '---';
      return `${place.name}\t${code}`;
    }
    return place.name;
  };

  const getRegionName = (place: Place) => {
    const stateCode = (place.state_code || '').trim();
    const countryCode = (place.country_code || '').trim().toUpperCase();
    if (countryCode && stateCode) {
      const resolved = stateNameByCountryAndCode.get(`${countryCode}:${stateCode.toUpperCase()}`);
      if (resolved) {
        return resolved;
      }
    }
    return formatRegionLabel(stateCode);
  };

  const getPlaceCardContent = (place: Place, type: PlaceType) => {
    const badges: string[] = [];
    let title = formatPlaceLabel(place, type);
    let subtitle = '';
    const countryName = place.country_code ? countryNameByCode.get(place.country_code.toUpperCase()) ?? place.country_code : '';
    const regionLabel = getRegionName(place);

    if (type === 'country') {
      title = place.name;
      if (place.country_code) badges.push(place.country_code);
    } else if (type === 'state') {
      title = place.name?.trim() || place.state_code || place.id.replace(/^state-[^-]+-/, '') || 'Unknown';
      if (regionLabel && regionLabel !== title) badges.push(regionLabel);
      if (countryName) subtitle = countryName;
    } else if (type === 'city') {
      title = [place.name, regionLabel, countryName].filter(Boolean).join(', ');
    } else if (type === 'airport') {
      title = place.name;
      subtitle = [place.municipality, regionLabel, countryName].filter(Boolean).join(', ') || place.location || '';
      if (place.airport_code) badges.push(place.airport_code);
    } else if (type === 'site') {
      const sourceConfig = getSiteSourceConfig(place);
      title = place.name;
      subtitle = [place.cityOrLocality, ...(place.countryOrCountries ?? [])].filter(Boolean).join(', ') || countryName || '';
      badges.push(sourceConfig.badge);
      const categoryLabel = formatSiteCategoryLabel(place.type || place.category || '');
      if (categoryLabel) badges.push(categoryLabel);
      if (place.sourceType === 'festival' && coerceBooleanMetadata(getSiteMetadataValue(place, 'heritage_recognized'))) {
        badges.push('Heritage-recognized');
      }
    }

    return { title, subtitle, badges };
  };

  return (
        <aside className="sidebar">
          <div className="tabs">
            {tabs.map((tab) => (
              <button
                key={tab.type}
                className={activeTab === tab.type ? 'active' : ''}
                onClick={() => setActiveTab(tab.type)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="tab-panel">
            <div className="tab-meta">
              <h2>{tabs.find((tab) => tab.type === activeTab)?.label}</h2>
            </div>

            <div className="filters">
              {activeTab === 'airport' ? (
                <>
                  <datalist id="airport-search-options">
                    {airportAutocompleteOptions.map((airport) => (
                      <option key={airport.id} value={airportLabelById.get(airport.id) ?? ''} />
                    ))}
                  </datalist>
                  <input
                    type="search"
                    list="airport-search-options"
                    placeholder="Search airport by code, name, city, state"
                    value={search.airport}
                    onChange={(event) => {
                      const value = event.target.value;
                      setSearch((prev) => ({
                        ...prev,
                        airport: value,
                      }));
                      setSelectedAirportSearchId(resolveAirportId(value));
                    }}
                  />
                </>
              ) : (
                <input
                  type="search"
                  placeholder={`Search ${activeTab}...`}
                  value={search[activeTab]}
                  onChange={(event) => setSearch((prev) => ({ ...prev, [activeTab]: event.target.value }))}
                />
              )}
              <label className="scope-filter">
                Scope
                <select
                  value={listScope[activeTab]}
                  onChange={(event) =>
                    setListScope((prev) => ({
                      ...prev,
                      [activeTab]: event.target.value as ListScope,
                    }))
                  }
                >
                  {getScopeOptions(activeTab).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {(activeTab === 'state' || activeTab === 'city') && (
                <MultiSelectDropdown
                  label="Visited countries"
                  options={visitedCountryScopeOptions.map((country) => ({ value: country.code, label: country.label }))}
                  selected={selectedVisitedCountries[activeTab]}
                  onToggle={(code) => onToggleVisitedCountrySelection(activeTab, code)}
                  onClear={() =>
                    setSelectedVisitedCountries((prev) => ({
                      ...prev,
                      [activeTab]: [],
                    }))
                  }
                  allLabel="All visited countries"
                  emptyText="No countries visited yet"
                />
              )}
              {activeTab === 'site' && (
                <>
                  <label className="scope-filter">
                    Source
                    <select
                      value={siteFilters.sourceType}
                      onChange={(event) => updateSiteSourceFilter(event.target.value)}
                    >
                      <option value="all">All sources</option>
                      <option value="unesco">UNESCO</option>
                      <option value="dark_sky">Dark Sky</option>
                      <option value="festival">Festival</option>
                      <option value="michelin">Michelin</option>
                    </select>
                  </label>
                  <label className="scope-filter">
                    Type / category
                    <select
                      value={siteFilters.category}
                      onChange={(event) => setSiteFilters((prev) => ({ ...prev, category: event.target.value }))}
                    >
                      {siteCategories.map((category) => (
                        <option key={category} value={category}>
                          {category === 'all'
                            ? `All ${siteFilters.sourceType === 'all' ? 'types' : siteSourceRegistry[siteFilters.sourceType as SiteSourceType].label.toLowerCase() + ' types'}`
                            : formatSiteCategoryLabel(category)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="scope-filter">
                    Country
                    <select
                      value={siteFilters.country}
                      onChange={(event) => setSiteFilters((prev) => ({ ...prev, country: event.target.value }))}
                    >
                      <option value="all">All countries</option>
                      {siteCountryOptions.map((country) => (
                        <option key={country.value} value={country.value}>
                          {country.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>

            <ul className="list">
              {placesLoading[activeTab] && visiblePlaces.length === 0 &&
                Array.from({ length: 8 }).map((_, index) => (
                  <li key={`skeleton-${index}`} className="place-card place-card--skeleton" aria-hidden="true">
                    <span className="place-card__skeleton-line" />
                  </li>
                ))}
              {visiblePlaces.map((place) => (
                <li key={place.id} className={`place-card place-card--${activeTab}${visitedIds.has(place.id) ? ' place-card--visited' : ''}`}>
                  <label
                    className={`place-card__label${activeTab === 'city' ? ' place-card__label--compact' : ''}`}
                    title={
                      typeof profileId === 'number' && canEditSelectedProfile
                        ? undefined
                        : 'Switch to a profile you own to track visits'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={visitedIds.has(place.id)}
                      disabled={typeof profileId !== 'number' || !canEditSelectedProfile}
                      onChange={() => onToggleVisit(place)}
                    />
                    {(() => {
                      const { title, subtitle, badges } = getPlaceCardContent(place, activeTab);
                      return (
                        <span className="place-card__body">
                          <span
                            className={`place-name place-card__title${activeTab === 'airport' ? ' airport-name' : ''}`}
                            onClick={(event) => {
                              // The title sits inside the checkbox label; block the
                              // label's default activation so clicking a name only
                              // focuses the map and never toggles the visit.
                              event.preventDefault();
                              focusOnPlace(place);
                            }}
                          >
                            {title}
                          </span>
                          {badges.length > 0 && (
                            <span className="place-card__badges" aria-hidden="true">
                              {badges.map((badge) => (
                                <span key={`${place.id}-${badge}`} className={`place-card__badge${activeTab === 'airport' ? ' airport-code' : ''}`}>
                                  {badge}
                                </span>
                              ))}
                            </span>
                          )}
                          {subtitle && <span className="place-card__subtitle">{subtitle}</span>}
                        </span>
                      );
                    })()}
                  </label>
                </li>
              ))}
              {activeFilteredPlaces.length > MAX_VISIBLE_LIST_ITEMS && (
                <li className="list-truncation-note">
                  Showing first {MAX_VISIBLE_LIST_ITEMS.toLocaleString()} of{' '}
                  {activeFilteredPlaces.length.toLocaleString()} results. Narrow search to reduce memory usage.
                </li>
              )}
            </ul>
          </div>
        </aside>
  );
}
