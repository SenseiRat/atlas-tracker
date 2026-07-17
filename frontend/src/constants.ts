import type { PlaceType, SiteFilterState } from './types';

export const tabs: { type: PlaceType; label: string }[] = [
  { type: 'country', label: 'Countries' },
  { type: 'state', label: 'States / Regions' },
  { type: 'city', label: 'Major Cities' },
  { type: 'airport', label: 'Major Airports' },
  { type: 'site', label: 'Sites & Lists' },
];

export const defaultSiteFilterState: SiteFilterState = {
  sourceType: 'all',
  category: 'all',
  country: 'all',
};
