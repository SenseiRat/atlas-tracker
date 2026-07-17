import { coerceBooleanMetadata, getSiteMetadataValue, getSiteSourceConfig } from '../lib/sites';
import { formatSiteCategoryLabel } from '../lib/format';
import type { ActiveProfile, MeasurementSystem, Place } from '../types';

type SiteDetailPanelProps = {
  place: Place;
  onClose: () => void;
};

export function SiteDetailPanel({ place, onClose }: SiteDetailPanelProps) {
  const sourceConfig = getSiteSourceConfig(place);
  const countries = place.countryOrCountries ?? [];
  const alternateNames = place.alternateNames ?? [];
  const tags = place.tags ?? [];
  const detailRows =
    place.sourceType === 'festival'
      ? [
          { label: 'Festival type', value: place.type },
          { label: 'Tradition', value: String(getSiteMetadataValue(place, 'tradition') ?? '').trim() || null },
          { label: 'Recurrence', value: String(getSiteMetadataValue(place, 'recurrence') ?? '').trim() || null },
          { label: 'Date notes', value: String(getSiteMetadataValue(place, 'date_notes') ?? '').trim() || null },
          {
            label: 'Globally famous',
            value: coerceBooleanMetadata(getSiteMetadataValue(place, 'globally_famous')) ? 'Yes' : 'No',
          },
          {
            label: 'Culturally significant',
            value: coerceBooleanMetadata(getSiteMetadataValue(place, 'culturally_significant')) ? 'Yes' : 'No',
          },
          {
            label: 'Heritage recognized',
            value: coerceBooleanMetadata(getSiteMetadataValue(place, 'heritage_recognized')) ? 'Yes' : 'No',
          },
        ]
      : place.sourceType === 'michelin'
        ? [
            { label: 'Distinction', value: String(getSiteMetadataValue(place, 'distinction') ?? '').trim() || place.type || null },
            { label: 'Cuisine', value: String(getSiteMetadataValue(place, 'cuisine') ?? '').trim() || null },
            { label: 'Price', value: String(getSiteMetadataValue(place, 'price') ?? '').trim() || null },
            { label: 'Guide link', value: String(getSiteMetadataValue(place, 'link') ?? '').trim() || null },
          ]
      : [
          { label: 'Type', value: place.type || formatSiteCategoryLabel(place.category || '') || null },
          { label: 'Region', value: place.region },
        ];

  return (
    <div className="detail-panel detail-panel--place">
      <div className="panel-header">
        <div>
          <h3>{place.name}</h3>
          <p>
            {sourceConfig.badge}
            {sourceConfig.recurringLabel ? ` · ${sourceConfig.recurringLabel}` : ''}
          </p>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="place-detail-card">
        <div className="place-detail-card__badges">
          <span className="place-detail-chip">{sourceConfig.badge}</span>
          {place.type && <span className="place-detail-chip">{formatSiteCategoryLabel(place.type)}</span>}
          {place.sourceType === 'festival' &&
            coerceBooleanMetadata(getSiteMetadataValue(place, 'heritage_recognized')) && (
              <span className="place-detail-chip">Heritage-recognized</span>
            )}
        </div>

        {alternateNames.length > 0 && (
          <p className="place-detail-meta">
            <strong>Alternate names:</strong> {alternateNames.join(', ')}
          </p>
        )}
        {place.cityOrLocality && (
          <p className="place-detail-meta">
            <strong>Locality:</strong> {place.cityOrLocality}
          </p>
        )}
        {countries.length > 0 && (
          <p className="place-detail-meta">
            <strong>Country / countries:</strong> {countries.join(', ')}
          </p>
        )}
        {place.region && (
          <p className="place-detail-meta">
            <strong>Region:</strong> {place.region}
          </p>
        )}
        {place.summary && <p className="place-detail-summary">{place.summary}</p>}
        {place.sourceType === 'festival' && (
          <p className="place-detail-note">
            Festival coordinates mark an anchor location for a recurring cultural event, not a permanent site boundary.
          </p>
        )}

        <div className="place-detail-grid">
          {detailRows
            .filter((row) => row.value)
            .map((row) => (
              <div key={row.label} className="place-detail-grid__item">
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            ))}
        </div>

        {tags.length > 0 && (
          <div className="place-detail-tags">
            {tags.map((tag) => (
              <span key={`${place.id}-${tag}`} className="place-detail-chip">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type PlaceDetailPanelProps = {
  place: Place;
  profileId: ActiveProfile;
  canEditSelectedProfile: boolean;
  visitedIds: Set<string>;
  countryNameByCode: Map<string, string>;
  measurementSystem: MeasurementSystem;
  onToggleVisit: (place: Place) => void;
  onClose: () => void;
};

export function PlaceDetailPanel({
  place,
  profileId,
  canEditSelectedProfile,
  visitedIds,
  countryNameByCode,
  measurementSystem,
  onToggleVisit,
  onClose,
}: PlaceDetailPanelProps) {
  const isAirport = place.id.startsWith('airport-');
  const countryName = countryNameByCode.get((place.country_code ?? '').toUpperCase());
  const rows: Array<{ label: string; value: string | null }> = [
    { label: 'Country', value: countryName ?? place.country_code ?? null },
    { label: 'Region', value: place.state_code ?? place.region ?? null },
    { label: isAirport ? 'Municipality' : 'Locality', value: place.municipality ?? place.cityOrLocality ?? null },
    { label: 'Airport code', value: isAirport ? place.airport_code ?? null : null },
    { label: 'Time zone', value: place.timezone ?? null },
    {
      label: 'Population',
      value: typeof place.population === 'number' ? place.population.toLocaleString() : null,
    },
    {
      label: 'Elevation',
      value:
        typeof place.elevation_m === 'number'
          ? measurementSystem === 'metric'
            ? `${Math.round(place.elevation_m).toLocaleString()} m`
            : `${Math.round(place.elevation_m * 3.28084).toLocaleString()} ft`
          : null,
    },
  ];
  const canToggle = typeof profileId === 'number' && canEditSelectedProfile;
  const isVisited = visitedIds.has(place.id);
  return (
    <div className="detail-panel detail-panel--place">
      <div className="panel-header">
        <div>
          <h3>{place.name}</h3>
          <p>{isAirport ? 'Airport' : 'City'}</p>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="place-detail-card">
        <div className="place-detail-grid">
          {rows
            .filter((row) => row.value)
            .map((row) => (
              <div key={row.label} className="place-detail-grid__item">
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            ))}
        </div>
        <button
          type="button"
          className={isVisited ? 'button-secondary' : 'button-primary'}
          disabled={!canToggle}
          title={canToggle ? undefined : 'Switch to a profile you own to track visits'}
          onClick={() => onToggleVisit(place)}
        >
          {isVisited ? 'Mark as not visited' : 'Mark as visited'}
        </button>
      </div>
    </div>
  );
}
