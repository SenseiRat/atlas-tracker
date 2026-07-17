import maplibregl, { LngLatBoundsLike, Map as MapLibreMap } from 'maplibre-gl';
import type { MapFeatureCollection, ThemeMode } from '../../types';
import { normalizeHexColor } from '../../lib/colors';

export const emptyFeatureCollection = (): MapFeatureCollection => ({
  type: 'FeatureCollection',
  features: [],
});

export function createAirportIconId(fill: string, stroke: string) {
  return `airport-icon-${normalizeHexColor(fill).slice(1)}-${normalizeHexColor(stroke).slice(1)}`;
}

function createAirportIconImage(fill: string, stroke: string) {
  const size = 40;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create airport icon canvas.');
  }

  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(20, 32);
  ctx.lineTo(20, 15);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(20, 11.5, 5.6, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(18.5, 30.5);
  ctx.lineTo(20, 34.5);
  ctx.lineTo(21.5, 30.5);
  ctx.closePath();
  ctx.fillStyle = stroke;
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}

export function createSiteIconId(fill: string, stroke: string) {
  return `site-icon-${normalizeHexColor(fill).slice(1)}-${normalizeHexColor(stroke).slice(1)}`;
}

function createSiteIconImage(fill: string, stroke: string) {
  const size = 44;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create site icon canvas.');
  }

  const center = size / 2;
  const outer = 13;
  const inner = 8.5;

  ctx.translate(center, center);
  ctx.rotate(Math.PI / 4);
  ctx.translate(-center, -center);

  ctx.beginPath();
  ctx.moveTo(center, center - outer);
  ctx.lineTo(center + inner, center - inner);
  ctx.lineTo(center + outer, center);
  ctx.lineTo(center + inner, center + inner);
  ctx.lineTo(center, center + outer);
  ctx.lineTo(center - inner, center + inner);
  ctx.lineTo(center - outer, center);
  ctx.lineTo(center - inner, center - inner);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(center, center, 3, 0, Math.PI * 2);
  ctx.fillStyle = stroke;
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}

export function createFestivalIconId(fill: string, stroke: string) {
  return `festival-icon-${normalizeHexColor(fill).slice(1)}-${normalizeHexColor(stroke).slice(1)}`;
}

function createFestivalIconImage(fill: string, stroke: string) {
  const size = 44;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create festival icon canvas.');
  }

  const center = size / 2;
  const outer = 12.5;
  const inner = 6;
  const spikes = 8;

  ctx.beginPath();
  for (let index = 0; index < spikes * 2; index += 1) {
    const angle = (-Math.PI / 2) + (index * Math.PI) / spikes;
    const radius = index % 2 === 0 ? outer : inner;
    const x = center + Math.cos(angle) * radius;
    const y = center + Math.sin(angle) * radius;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = 'round';
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(center, center, 3.2, 0, Math.PI * 2);
  ctx.fillStyle = stroke;
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}

export function ensureAirportIcons(
  map: MapLibreMap,
  icons: Array<{
    fill: string;
    stroke: string;
  }>,
) {
  const missingIcons = icons.filter(({ fill, stroke }) => !map.hasImage(createAirportIconId(fill, stroke)));
  if (missingIcons.length === 0) return;

  missingIcons.forEach(({ fill, stroke }) => {
    map.addImage(createAirportIconId(fill, stroke), createAirportIconImage(fill, stroke), { pixelRatio: 2 });
  });
}

export function ensureSiteIcons(
  map: MapLibreMap,
  icons: Array<{
    fill: string;
    stroke: string;
  }>,
) {
  const missingIcons = icons.filter(({ fill, stroke }) => !map.hasImage(createSiteIconId(fill, stroke)));
  if (missingIcons.length === 0) return;

  missingIcons.forEach(({ fill, stroke }) => {
    map.addImage(createSiteIconId(fill, stroke), createSiteIconImage(fill, stroke), { pixelRatio: 2 });
  });
}

export function ensureFestivalIcons(
  map: MapLibreMap,
  icons: Array<{
    fill: string;
    stroke: string;
  }>,
) {
  const missingIcons = icons.filter(({ fill, stroke }) => !map.hasImage(createFestivalIconId(fill, stroke)));
  if (missingIcons.length === 0) return;

  missingIcons.forEach(({ fill, stroke }) => {
    map.addImage(createFestivalIconId(fill, stroke), createFestivalIconImage(fill, stroke), { pixelRatio: 2 });
  });
}

function extendBoundsWithCoordinates(bounds: maplibregl.LngLatBounds, coords: any) {
  coords.forEach((coord: any) => {
    if (typeof coord?.[0] === 'number' && typeof coord?.[1] === 'number') {
      bounds.extend(coord as [number, number]);
      return;
    }
    extendBoundsWithCoordinates(bounds, coord);
  });
}

export function fitMapToFeature(map: MapLibreMap, feature: MapFeatureCollection['features'][number], padding = 40) {
  const geometry = feature.geometry;
  if (!geometry) return false;

  if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
    const [lon, lat] = geometry.coordinates;
    map.flyTo({ center: [lon, lat], zoom: 5, duration: 800 });
    return true;
  }

  if (
    (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon' || geometry.type === 'LineString') &&
    geometry.coordinates
  ) {
    const bounds = new maplibregl.LngLatBounds();
    extendBoundsWithCoordinates(bounds, geometry.coordinates);
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds as LngLatBoundsLike, { padding, duration: 800 });
      return true;
    }
  }

  return false;
}

// Raster basemaps bake their labels into the tiles, so "label language" is a
// choice between basemaps: OSM standard renders local place names, CARTO
// Voyager renders English/international labels.
export const basemapTilesByLabelLanguage: Record<'local' | 'english', string[]> = {
  local: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  english: ['https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'],
};

export const baseStyle = {
  version: 8,
  name: 'Tracker',
  sources: {
    osm: {
      type: 'raster',
      tiles: basemapTilesByLabelLanguage.local,
      tileSize: 256,
      attribution: '© OpenStreetMap contributors · © CARTO',
      maxzoom: 19,
    },
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': '#7fb3d5',
      },
    },
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-opacity': 0.9 },
    },
  ],
};

export const mapThemeTokens: Record<
  ThemeMode,
  {
    background: string;
    countryDefault: string;
    countryOutline: string;
    stroke: string;
    city: string;
    airport: string;
    site: string;
    route: string;
    rasterSaturation: number;
    rasterContrast: number;
    rasterBrightnessMin: number;
    rasterBrightnessMax: number;
  }
> = {
  dark: {
    background: '#091321',
    countryDefault: '#5f7287',
    countryOutline: '#d4e1ef',
    stroke: '#e6eef8',
    city: '#7dd3fc',
    airport: '#f59e0b',
    site: '#c084fc',
    route: '#f4b860',
    rasterSaturation: -0.38,
    rasterContrast: 0.12,
    rasterBrightnessMin: 0.17,
    rasterBrightnessMax: 0.7,
  },
  light: {
    background: '#dbe8f2',
    countryDefault: '#d7e0ea',
    countryOutline: '#31465c',
    stroke: '#102235',
    city: '#0f766e',
    airport: '#c2410c',
    site: '#a21caf',
    route: '#0f4c81',
    rasterSaturation: -0.1,
    rasterContrast: 0.04,
    rasterBrightnessMin: 0.88,
    rasterBrightnessMax: 1.12,
  },
};
