import type { MeasurementSystem } from '../types';

export function formatDistance(valueMiles: number, measurementSystem: MeasurementSystem) {
  if (measurementSystem === 'metric') {
    return `${Math.round(valueMiles * 1.60934).toLocaleString()} km`;
  }
  return `${Math.round(valueMiles).toLocaleString()} mi`;
}

export const formatSiteCategoryLabel = (category?: string) =>
  category
    ? category
        .replaceAll('/', ' / ')
        .split('_')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
    : '';

export const formatRegionLabel = (value?: string) => {
  const label = (value || '').trim();
  return label && !/^\d+$/.test(label) ? label : '';
};
