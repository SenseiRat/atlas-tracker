import { ChangeEvent, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import maplibregl, { LngLatBoundsLike, Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { AchievementsPanel } from './AchievementsPanel';
import { TravelStatsPanel } from './TravelStatsPanel';
import { buildAchievementModel } from './achievements';
import { buildTravelStatsModel } from './travelStats';

type PlaceType = 'country' | 'state' | 'city' | 'airport' | 'site';
type ActiveProfile = number | 'all' | null;
type ListScope = 'all' | 'visited' | 'unvisited' | 'visited_countries';
type MainView = 'map' | 'trips' | 'stats' | 'achievements' | 'leaderboard';
type Place = {
  id: string;
  name: string;
  country_code?: string;
  state_code?: string;
  municipality?: string;
  lat?: number;
  lon?: number;
  airport_code?: string;
  airport_type?: string;
  location?: string;
  search_location?: string;
  category?: string;
  timezone?: string;
  elevation_m?: number | null;
  feature_code?: string;
  feature_class?: string;
  population?: number | null;
  area_sqkm?: number | null;
  continent?: string;
  country_codes?: string[] | null;
  source?: string;
};

type PlacesResponse = {
  items: Place[];
  total?: number | null;
  limit: number;
  offset: number;
  has_more?: boolean;
  next_offset?: number;
};

type Visit = {
  profile_id: number;
  place_id: string;
  visited_at?: string | null;
  trip_id?: string | null;
};

type TripLog = {
  id: number;
  profile_id: number;
  flown_on?: string | null;
  origin_place_id: string;
  destination_place_id: string;
  layover_place_ids: string[];
  estimated_miles: number;
  created_at: string;
  route_points: Array<{
    id: string;
    name: string;
    lat: number;
    lon: number;
    country_code?: string;
  }>;
  segments: Array<{
    from_place_id: string;
    to_place_id: string;
    from_name: string;
    to_name: string;
    miles: number;
  }>;
};

type Measurement = {
  id: string;
  label: string;
  place_name: string;
  value: number | string;
  display_value: string;
  detail?: string | null;
  unit?: string | null;
};

type Achievement = {
  id: string;
  title: string;
  description: string;
  category: string;
  current: number;
  target: number;
  points: number;
  earned: boolean;
  progress_current: number;
  progress_target: number;
  progress_percent: number;
  progress_label: string;
  earned_by_public_profiles?: number;
  rarity_percent?: number;
};

type LeaderboardProfile = {
  profile_id: number;
  name: string;
  color: string;
  overall_score?: number;
  countries?: number;
  continents?: number;
  miles?: number;
  achievements?: number;
  value?: number;
};

type Stats = {
  continents: { visited: number; total: number };
  countries: { visited: number; total: number; percent: number };
  states: { visited: number; total: number };
  cities: { visited: number; total: number };
  airports: { visited: number; total: number };
  sites: { visited: number; total: number };
  trip_logs: {
    count: number;
    flight_legs: number;
    estimated_miles: number;
    average_miles_per_trip: number;
  };
  hemispheres: {
    north: number;
    south: number;
    east: number;
    west: number;
    quadrants: { ne: number; nw: number; se: number; sw: number };
    overlap: { north_south: boolean; east_west: boolean; all_four_quadrants: boolean };
  };
  geo_extremes: {
    farthest_north?: { name: string; lat: number } | null;
    farthest_south?: { name: string; lat: number } | null;
    easternmost?: { name: string; lon: number } | null;
    westernmost?: { name: string; lon: number } | null;
    highest_elevation?: { name: string; elevation_m: number } | null;
    lowest_elevation?: { name: string; elevation_m: number } | null;
  };
  travel: {
    distance_miles: number;
    distance_km: number;
    timezones_visited: number;
    currencies_used: number;
    longest_trip_streak_days: number;
    repeated_airports: number;
  };
  site_categories: Record<string, { visited: number; total: number }>;
  measurements: Measurement[];
  achievements: {
    earned: number;
    total: number;
    score: number;
    items: Achievement[];
  };
  scorecard: {
    overall_score: number;
    achievement_score: number;
  };
  leaderboard: {
    public_profile_count: number;
    current_profile?: {
      eligible: boolean;
      profile_id: number;
      overall_rank?: number | null;
      country_rank?: number | null;
      continent_rank?: number | null;
      miles_rank?: number | null;
      achievement_rank?: number | null;
      leader_categories: string[];
      overall_score: number;
    } | null;
    top_overall: LeaderboardProfile[];
    categories: Array<{
      id: string;
      label: string;
      leaders: LeaderboardProfile[];
    }>;
  };
};

type Profile = {
  id: number;
  name: string;
  color: string;
  is_public: boolean;
  is_owned: boolean;
  owner_user_id?: number | null;
};
type AuthSession = {
  oidc_enabled: boolean;
  authenticated: boolean;
  auth_mode?: 'oidc' | 'local';
  local_users_count?: number;
  has_local_users?: boolean;
  app_settings?: AppSettings;
  user?: {
    id: number;
    username?: string | null;
    email?: string | null;
    display_name?: string | null;
    role?: 'admin' | 'user';
    is_admin?: boolean;
  } | null;
};

type AppSettings = {
  preferred_db_backend: 'sqlite' | 'postgres' | string;
  configured_db_backend: 'sqlite' | 'postgres' | string;
  auth_mode: 'local' | 'oidc' | string;
  oidc_enabled: boolean;
  oidc_issuer?: string;
  oidc_client_id?: string;
  oidc_client_secret?: string;
  db_host?: string;
  db_port?: string;
  db_name?: string;
  db_user?: string;
  db_password?: string;
  sqlite_db_path?: string;
  restart_required?: boolean;
};

type AdminUser = {
  id: number;
  username?: string | null;
  email?: string | null;
  display_name?: string | null;
  role: 'admin' | 'user';
  is_admin: boolean;
};

type AdminProfile = Profile & {
  owner_label?: string;
};

type MapFeatureCollection = {
  type: 'FeatureCollection';
  features: Array<{
    id: string;
    geometry: any;
    properties: Record<string, unknown>;
  }>;
};

const emptyFeatureCollection = (): MapFeatureCollection => ({
  type: 'FeatureCollection',
  features: [],
});

const tabs: { type: PlaceType; label: string }[] = [
  { type: 'country', label: 'Countries' },
  { type: 'state', label: 'States / Regions' },
  { type: 'city', label: 'Major Cities' },
  { type: 'airport', label: 'Major Airports' },
  { type: 'site', label: 'Sites & Lists' },
];

const profilePalette = [
  '#16a34a',
  '#0f766e',
  '#0891b2',
  '#0284c7',
  '#2563eb',
  '#4f46e5',
  '#7c3aed',
  '#9333ea',
  '#c026d3',
  '#db2777',
  '#e11d48',
  '#dc2626',
  '#ea580c',
  '#ca8a04',
  '#65a30d',
];
const defaultProfileColor = profilePalette[0];

function normalizeHexColor(raw: string | undefined, fallback = defaultProfileColor) {
  const value = (raw ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function hexToRgb(hex: string) {
  const normalized = normalizeHexColor(hex);
  const parsed = Number.parseInt(normalized.slice(1), 16);
  return {
    r: (parsed >> 16) & 0xff,
    g: (parsed >> 8) & 0xff,
    b: parsed & 0xff,
  };
}

function rgbToHex(r: number, g: number, b: number) {
  const toHex = (channel: number) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToHsl(r: number, g: number, b: number) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;

  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    switch (max) {
      case rr:
        hue = ((gg - bb) / delta) % 6;
        break;
      case gg:
        hue = (bb - rr) / delta + 2;
        break;
      default:
        hue = (rr - gg) / delta + 4;
        break;
    }
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  return { h: hue, s: saturation, l: lightness };
}

function hslToRgb(h: number, s: number, l: number) {
  const hue = ((h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = l - chroma / 2;
  let r = 0;
  let g = 0;
  let b = 0;

  if (hue < 60) {
    r = chroma;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = chroma;
  } else if (hue < 180) {
    g = chroma;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = chroma;
  } else if (hue < 300) {
    r = x;
    b = chroma;
  } else {
    r = chroma;
    b = x;
  }

  return {
    r: (r + match) * 255,
    g: (g + match) * 255,
    b: (b + match) * 255,
  };
}

function adjustHexColor(
  hex: string,
  adjustments: {
    hueShift?: number;
    saturationDelta?: number;
    lightnessDelta?: number;
  },
) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const shiftedHue = h + (adjustments.hueShift ?? 0);
  const nextSaturation = clamp(s + (adjustments.saturationDelta ?? 0), 0, 1);
  const nextLightness = clamp(l + (adjustments.lightnessDelta ?? 0), 0, 1);
  const nextRgb = hslToRgb(shiftedHue, nextSaturation, nextLightness);
  return rgbToHex(nextRgb.r, nextRgb.g, nextRgb.b);
}

function mixHexColors(first: string, second: string, ratio = 0.5) {
  const weight = clamp(ratio, 0, 1);
  const a = hexToRgb(first);
  const b = hexToRgb(second);
  return rgbToHex(
    a.r * (1 - weight) + b.r * weight,
    a.g * (1 - weight) + b.g * weight,
    a.b * (1 - weight) + b.b * weight,
  );
}

function contrastingColor(hex: string) {
  const normalized = normalizeHexColor(hex);
  const parsed = Number.parseInt(normalized.slice(1), 16);
  const r = (parsed >> 16) & 0xff;
  const g = (parsed >> 8) & 0xff;
  const b = parsed & 0xff;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.55 ? '#0b1220' : '#f8fafc';
}

function createProfileVisuals(baseColor: string, themeMode: ThemeMode) {
  const normalized = normalizeHexColor(baseColor);

  const country = themeMode === 'dark' ? mixHexColors(normalized, '#dbeafe', 0.12) : mixHexColors(normalized, '#0f172a', 0.08);
  const stateFill =
    themeMode === 'dark'
      ? adjustHexColor(normalized, { saturationDelta: 0.08, lightnessDelta: -0.02 })
      : adjustHexColor(normalized, { saturationDelta: 0.06, lightnessDelta: -0.12 });
  const selectedRegion =
    themeMode === 'dark'
      ? adjustHexColor(normalized, { saturationDelta: 0.04, lightnessDelta: 0.12 })
      : adjustHexColor(normalized, { saturationDelta: 0.02, lightnessDelta: 0.02 });
  const city =
    themeMode === 'dark'
      ? adjustHexColor(normalized, { hueShift: -18, saturationDelta: 0.04, lightnessDelta: 0.18 })
      : adjustHexColor(normalized, { hueShift: -14, saturationDelta: 0.08, lightnessDelta: -0.04 });
  const airportBase =
    themeMode === 'dark'
      ? adjustHexColor(normalized, { hueShift: 176, saturationDelta: 0.04, lightnessDelta: 0.14 })
      : adjustHexColor(normalized, { hueShift: 176, saturationDelta: -0.02, lightnessDelta: -0.08 });
  const airport =
    themeMode === 'dark'
      ? mixHexColors(airportBase, '#f8fafc', 0.08)
      : mixHexColors(airportBase, '#0f172a', 0.06);
  const site =
    themeMode === 'dark'
      ? adjustHexColor(normalized, { hueShift: 28, saturationDelta: -0.02, lightnessDelta: 0.08 })
      : adjustHexColor(normalized, { hueShift: 30, saturationDelta: 0.01, lightnessDelta: -0.1 });
  const route =
    themeMode === 'dark'
      ? adjustHexColor(normalized, { hueShift: -10, saturationDelta: -0.06, lightnessDelta: 0.1 })
      : adjustHexColor(normalized, { hueShift: -8, saturationDelta: -0.02, lightnessDelta: -0.14 });

  return {
    base: normalized,
    country,
    stateFill,
    selectedRegion,
    city,
    airport,
    site,
    route,
  };
}

function createAirportIconId(fill: string, stroke: string) {
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

function createSiteIconId(fill: string, stroke: string) {
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

function ensureAirportIcons(
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

function ensureSiteIcons(
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

function extendBoundsWithCoordinates(bounds: maplibregl.LngLatBounds, coords: any) {
  coords.forEach((coord: any) => {
    if (typeof coord?.[0] === 'number' && typeof coord?.[1] === 'number') {
      bounds.extend(coord as [number, number]);
      return;
    }
    extendBoundsWithCoordinates(bounds, coord);
  });
}

function fitMapToFeature(map: MapLibreMap, feature: MapFeatureCollection['features'][number], padding = 40) {
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

const baseStyle = {
  version: 8,
  name: 'Tracker',
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
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

type ThemeMode = 'dark' | 'light';

const mapThemeTokens: Record<
  ThemeMode,
  {
    background: string;
    countryDefault: string;
    countryOutline: string;
    clusterColor: string;
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
    clusterColor: '#93c5fd',
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
    clusterColor: '#2563eb',
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Request failed: ${response.status} ${details}`);
  }
  return response.json() as Promise<T>;
}

function App() {
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const countryGeoRef = useRef<MapFeatureCollection | null>(null);
  const stateGeoRef = useRef<MapFeatureCollection | null>(null);

  const [isMapReady, setIsMapReady] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showSettingsOverlay, setShowSettingsOverlay] = useState(false);
  const [showCreateProfileModal, setShowCreateProfileModal] = useState(false);
  const [showEditProfileModal, setShowEditProfileModal] = useState(false);
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [isProfileSubmitting, setIsProfileSubmitting] = useState(false);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [registerUsername, setRegisterUsername] = useState('');
  const [registerDisplayName, setRegisterDisplayName] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState('');
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminProfiles, setAdminProfiles] = useState<AdminProfile[]>([]);
  const [adminSettings, setAdminSettings] = useState<AppSettings | null>(null);
  const [newAdminUserUsername, setNewAdminUserUsername] = useState('');
  const [newAdminUserDisplayName, setNewAdminUserDisplayName] = useState('');
  const [newAdminUserPassword, setNewAdminUserPassword] = useState('');
  const [newAdminUserIsAdmin, setNewAdminUserIsAdmin] = useState(false);
  const [newAdminProfileName, setNewAdminProfileName] = useState('');
  const [newAdminProfileOwnerId, setNewAdminProfileOwnerId] = useState('');
  const [newAdminProfileColor, setNewAdminProfileColor] = useState(defaultProfileColor);
  const [newAdminProfilePublic, setNewAdminProfilePublic] = useState(false);
  const [adminPasswordReset, setAdminPasswordReset] = useState<Record<number, string>>({});
  const [adminUserEdits, setAdminUserEdits] = useState<Record<number, { username: string; display_name: string }>>({});
  const [mainView, setMainView] = useState<MainView>('map');
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem('tracker-theme');
    return stored === 'light' ? 'light' : 'dark';
  });

  const [activeTab, setActiveTab] = useState<PlaceType>('country');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<ActiveProfile>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tripLogs, setTripLogs] = useState<TripLog[]>([]);
  const [showTripRoutes, setShowTripRoutes] = useState(false);
  const [showTripForm, setShowTripForm] = useState(false);
  const [selectedMapPlaceId, setSelectedMapPlaceId] = useState<string | null>(null);
  const [tripForm, setTripForm] = useState({
    flown_on: '',
    origin_place_id: '',
    origin_query: '',
    destination_place_id: '',
    destination_query: '',
    layovers: [''],
    layover_queries: [''],
  });

  const [places, setPlaces] = useState<Record<PlaceType, Place[]>>({
    country: [],
    state: [],
    city: [],
    airport: [],
    site: [],
  });
  const [visits, setVisits] = useState<Visit[]>([]);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileColor, setNewProfileColor] = useState(defaultProfileColor);
  const [newProfilePublic, setNewProfilePublic] = useState(false);
  const [editProfileName, setEditProfileName] = useState('');
  const [selectedProfileColor, setSelectedProfileColor] = useState(defaultProfileColor);
  const [selectedProfilePublic, setSelectedProfilePublic] = useState(false);
  const [showFirstProfilePrompt, setShowFirstProfilePrompt] = useState(false);
  const [accountUsername, setAccountUsername] = useState('');
  const [accountDisplayName, setAccountDisplayName] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [accountConfirmPassword, setAccountConfirmPassword] = useState('');
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
  const [siteCategoryFilter, setSiteCategoryFilter] = useState('all');
  const [selectedVisitedCountries, setSelectedVisitedCountries] = useState<Record<'state' | 'city', string[]>>({
    state: [],
    city: [],
  });
  const deferredSearch = useDeferredValue(search);

  const nextSuggestedProfileColor = useMemo(() => {
    const used = new Set(profiles.map((profile) => normalizeHexColor(profile.color)));
    return profilePalette.find((color) => !used.has(color)) ?? profilePalette[profiles.length % profilePalette.length];
  }, [profiles]);

  const profileColorById = useMemo(() => {
    const map = new Map<number, string>();
    profiles.forEach((profile, index) =>
      map.set(profile.id, normalizeHexColor(profile.color, profilePalette[index % profilePalette.length])),
    );
    return map;
  }, [profiles]);

  const profileVisualsById = useMemo(() => {
    const map = new Map<number, ReturnType<typeof createProfileVisuals>>();
    profileColorById.forEach((color, id) => {
      map.set(id, createProfileVisuals(color, themeMode));
    });
    return map;
  }, [profileColorById, themeMode]);

  useEffect(() => {
    if (typeof profileId !== 'number') {
      setSelectedProfileColor(defaultProfileColor);
      setSelectedProfilePublic(false);
      return;
    }
    const active = profiles.find((profile) => profile.id === profileId);
    setEditProfileName(active?.name ?? '');
    setSelectedProfileColor(normalizeHexColor(active?.color));
    setSelectedProfilePublic(Boolean(active?.is_public));
  }, [profiles, profileId]);

  useEffect(() => {
    const nextUsers = Object.fromEntries(
      adminUsers.map((user) => [
        user.id,
        {
          username: user.username ?? '',
          display_name: user.display_name ?? '',
        },
      ]),
    );
    setAdminUserEdits(nextUsers);
  }, [adminUsers]);

  useEffect(() => {
    setAccountUsername(authSession?.user?.username ?? '');
    setAccountDisplayName(authSession?.user?.display_name ?? '');
    setAccountPassword('');
    setAccountConfirmPassword('');
  }, [authSession?.user?.id, authSession?.user?.username, authSession?.user?.display_name]);

  useEffect(() => {
    if (!showSettingsOverlay) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [showSettingsOverlay]);

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

  const siteCategories = useMemo(() => {
    const categories = new Set(
      places.site
        .map((site) => (site.category || '').trim().toLowerCase())
        .filter((category) => Boolean(category)),
    );
    return ['all', ...Array.from(categories).sort()];
  }, [places.site]);

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

  const airportAutocomplete = (input: string) => {
    const normalized = input.trim().toLowerCase();
    if (!normalized) return airportOptions.slice(0, 60);
    return airportOptions
      .filter((airport) => (placeSearchTextByType.airport.get(airport.id) ?? '').includes(normalized))
      .slice(0, 60);
  };

  const airportAutocompleteOptions = useMemo(() => {
    return airportAutocomplete(deferredSearch.airport);
  }, [airportOptions, deferredSearch.airport, placeSearchTextByType]);

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

  const visitedIds = useMemo(() => {
    if (profileId === 'all' || profileId === null) {
      return new Set(visits.map((visit) => visit.place_id));
    }
    return new Set(visits.filter((visit) => visit.profile_id === profileId).map((visit) => visit.place_id));
  }, [visits, profileId]);

  const selectedProfile = useMemo(
    () => (typeof profileId === 'number' ? profiles.find((profile) => profile.id === profileId) ?? null : null),
    [profiles, profileId],
  );
  const canEditSelectedProfile = Boolean(authSession?.authenticated && selectedProfile?.is_owned);
  const isAdmin = Boolean(authSession?.user?.is_admin);
  const ownedProfiles = useMemo(() => profiles.filter((profile) => profile.is_owned), [profiles]);
  const publicProfiles = useMemo(() => profiles.filter((profile) => !profile.is_owned && profile.is_public), [profiles]);

  const renderProfileColorField = (
    value: string,
    onChange: (color: string) => void,
    label = 'Color',
  ) => {
    const normalized = normalizeHexColor(value);
    return (
      <div className="profile-color-picker" role="radiogroup" aria-label={label}>
        <span className="profile-color-picker__label">{label}</span>
        <div className="profile-color-grid">
          {profilePalette.map((color) => (
            <button
              key={color}
              type="button"
              className={`profile-color-option${normalized === color ? ' profile-color-option--active' : ''}`}
              onClick={() => onChange(color)}
              role="radio"
              aria-checked={normalized === color}
              aria-label={`Use ${color}`}
            >
              <span className="profile-color-option__frame" aria-hidden="true">
                <span className="profile-color-option__swatch" style={{ '--swatch-color': color } as CSSProperties} />
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  const visitedCountryCodes = useMemo(() => {
    const codes = new Set<string>();
    visitedIds.forEach((id) => {
      if (id.startsWith('country-')) {
        codes.add(id.replace('country-', '').toUpperCase());
      }
    });
    return codes;
  }, [visitedIds]);

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

  const isCollectiveDemoMode = profileId === null;
  const isAttributedProfileAggregate = profileId === 'all';
  const isMultiProfileView = isCollectiveDemoMode || isAttributedProfileAggregate;
  const defaultVisuals = useMemo(() => createProfileVisuals(defaultProfileColor, themeMode), [themeMode]);
  const activeVisits = useMemo(
    () => (isMultiProfileView ? visits : visits.filter((visit) => visit.profile_id === profileId)),
    [isMultiProfileView, visits, profileId],
  );
  const activeTrips = useMemo(
    () => (isMultiProfileView ? tripLogs : tripLogs.filter((trip) => trip.profile_id === profileId)),
    [isMultiProfileView, tripLogs, profileId],
  );
  const pointLookup = useMemo(
    () => new Map([...places.city, ...places.airport, ...places.site].map((place) => [place.id, place] as const)),
    [places.city, places.airport, places.site],
  );
  const stateVisitById = useMemo(
    () => new Map(activeVisits.filter((visit) => visit.place_id.startsWith('state-')).map((visit) => [visit.place_id, visit] as const)),
    [activeVisits],
  );
  const travelStatsModel = useMemo(
    () =>
      buildTravelStatsModel({
        places,
        visits: activeVisits,
        tripLogs: activeTrips,
      }),
    [activeTrips, activeVisits, places],
  );
  const achievementModel = useMemo(
    () =>
      buildAchievementModel({
        places,
        visits: activeVisits,
        tripLogs: activeTrips,
      }),
    [activeTrips, activeVisits, places],
  );

  useEffect(() => {
    localStorage.setItem('tracker-theme', themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (showFirstProfilePrompt) {
      setNewProfileColor(nextSuggestedProfileColor);
    }
  }, [showFirstProfilePrompt, nextSuggestedProfileColor]);

  useEffect(() => {
    let cancelled = false;
    api<AuthSession>('/api/auth/session')
      .then((session) => {
        if (cancelled) return;
        setAuthSession(session);
      })
      .catch(() => {
        if (cancelled) return;
        setAuthSession({ oidc_enabled: false, authenticated: false, user: null });
        setUiError('Unable to load authentication state.');
      })
      .finally(() => {
        if (cancelled) return;
        setAuthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canLoadAppData = !authLoading;

  const refreshAuthSession = async () => {
    const session = await api<AuthSession>('/api/auth/session');
    setAuthSession(session);
    setAdminSettings(session.app_settings ?? null);
    return session;
  };

  const refreshAdminData = async () => {
    if (!isAdmin) return;
    const [users, serverProfiles, settings] = await Promise.all([
      api<AdminUser[]>('/api/admin/users'),
      api<AdminProfile[]>('/api/admin/profiles'),
      api<AppSettings>('/api/admin/settings'),
    ]);
    setAdminUsers(users);
    setAdminProfiles(serverProfiles);
    setAdminSettings(settings);
  };

  const refreshProfiles = async () => {
    const data = await api<Profile[]>('/api/profiles');
    setProfiles(data);
    const ownedProfiles = data.filter((profile) => profile.is_owned);
    const publicProfiles = data.filter((profile) => !profile.is_owned && profile.is_public);
    const preferred = authSession?.authenticated ? ownedProfiles[0] ?? publicProfiles[0] : publicProfiles[0];

    const hasCurrentSelection =
      profileId === null ||
      profileId === 'all' ||
      (typeof profileId === 'number' && data.some((profile) => profile.id === profileId));
    if (!hasCurrentSelection) {
      setProfileId(preferred?.id ?? null);
    }
    setShowFirstProfilePrompt(Boolean(authSession?.authenticated) && ownedProfiles.length === 0);
  };

  const refreshVisitsStatsAndTrips = async (active: ActiveProfile) => {
    const visitsPath = active === null || active === 'all' ? '/api/visits' : `/api/visits?profile_id=${active}`;
    const statsPath = active === null || active === 'all' ? '/api/stats' : `/api/stats?profile_id=${active}`;
    const tripsPath = active === null || active === 'all' ? '/api/trip-logs' : `/api/trip-logs?profile_id=${active}`;

    const [visitsData, statsData, tripsData] = await Promise.all([
      api<Visit[]>(visitsPath),
      api<Stats>(statsPath),
      api<TripLog[]>(tripsPath),
    ]);

    setVisits(visitsData);
    setStats(statsData);
    setTripLogs(tripsData);
  };

  useEffect(() => {
    if (!canLoadAppData) return;
    refreshProfiles().catch(() => {
      setProfiles([]);
      setProfileId(null);
      setUiError('Unable to load profiles.');
    });
  }, [canLoadAppData, authSession?.authenticated]);

  useEffect(() => {
    if (!isAdmin) {
      setAdminUsers([]);
      setAdminProfiles([]);
      return;
    }
    refreshAdminData().catch(() => {
      setUiError('Unable to load admin settings.');
    });
  }, [isAdmin]);

  useEffect(() => {
    if (!canLoadAppData) return;
    refreshVisitsStatsAndTrips(profileId).catch(() => {
      setVisits([]);
      setStats(null);
      setTripLogs([]);
      setUiError('Unable to load visits/trips/stats.');
    });
  }, [profileId, canLoadAppData]);

  useEffect(() => {
    if (!canLoadAppData) return;
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
  }, [canLoadAppData]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: baseStyle as any,
        center: [10, 25],
        zoom: 1.4,
        maxZoom: 7,
        minZoom: 1,
      });
    } catch (error) {
      setUiError('Map failed to initialize.');
      console.error(error);
      return;
    }

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    let didInitLayers = false;

    const initMapLayers = async () => {
      if (didInitLayers) return;
      didInitLayers = true;
      try {
        const theme = mapThemeTokens[themeMode];
        const [countryResult, stateResult] = await Promise.allSettled([
          api<MapFeatureCollection>('/api/places/geojson?type=country'),
          api<MapFeatureCollection>('/api/places/geojson?type=state'),
        ]);

        if (countryResult.status !== 'fulfilled') {
          throw countryResult.reason;
        }

        const countryGeo = countryResult.value;
        const stateGeo = stateResult.status === 'fulfilled' ? stateResult.value : emptyFeatureCollection();
        countryGeoRef.current = countryGeo;
        stateGeoRef.current = stateGeo;

        if (stateResult.status !== 'fulfilled') {
          console.error('State layer failed to load.', stateResult.reason);
          setUiError((current) => current ?? 'State overlays could not be loaded.');
        }

        map.addSource('countries', { type: 'geojson', data: countryGeo as any });
        map.addLayer({
          id: 'country-fill',
          type: 'fill',
          source: 'countries',
          paint: {
            'fill-color': ['coalesce', ['get', 'visit_color'], theme.countryDefault],
            'fill-opacity': ['case', ['boolean', ['get', 'visited'], false], 0.41, 0.19],
          },
        });
        map.addLayer({
          id: 'country-outline',
          type: 'line',
          source: 'countries',
          paint: { 'line-color': theme.countryOutline, 'line-width': 1.2 },
        });
        map.addSource('trip-routes', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] } as any,
        });
        map.addLayer({
          id: 'trip-routes-line',
          type: 'line',
          source: 'trip-routes',
          paint: {
            'line-color': ['coalesce', ['get', 'route_color'], theme.route],
            'line-width': 2.5,
            'line-opacity': 0.75,
          },
        });

        map.addSource('points', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] } as any,
        });
        map.addSource('visited-states', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] } as any,
        });
        map.addSource('selected-region', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] } as any,
        });
        map.addLayer({
          id: 'visited-states-fill',
          type: 'fill',
          source: 'visited-states',
          filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
          paint: {
            'fill-color': ['coalesce', ['get', 'marker_color'], theme.route],
            'fill-opacity': 0.2,
          },
        });
        map.addLayer({
          id: 'visited-states-outline',
          type: 'line',
          source: 'visited-states',
          filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
          paint: {
            'line-color': '#000000',
            'line-width': 2.8,
            'line-opacity': 0.95,
          },
        });
        map.addLayer({
          id: 'selected-region-fill',
          type: 'fill',
          source: 'selected-region',
          filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
          paint: {
            'fill-color': ['coalesce', ['get', 'selection_color'], theme.route],
            'fill-opacity': 0.14,
          },
        });
        map.addLayer({
          id: 'selected-region-outline',
          type: 'line',
          source: 'selected-region',
          filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
          paint: {
            'line-color': '#000000',
            'line-width': 4,
            'line-opacity': 0.95,
          },
        });
        map.addLayer({
          id: 'visited-states-ring',
          type: 'circle',
          source: 'visited-states',
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-color': ['coalesce', ['get', 'marker_color'], theme.route],
            'circle-opacity': 0.9,
            'circle-radius': 8,
            'circle-stroke-color': ['coalesce', ['get', 'marker_stroke'], theme.stroke],
            'circle-stroke-width': 1.3,
            'circle-stroke-opacity': 0.9,
          },
        });
        map.addLayer({
          id: 'points',
          type: 'circle',
          source: 'points',
          filter: ['==', ['get', 'point_type'], 'city'],
          paint: {
            'circle-color': ['coalesce', ['get', 'marker_color'], theme.airport],
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 2.2, 3, 3.2, 6, 4.6, 10, 6.4, 14, 8.2],
            'circle-stroke-color': '#000000',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 0, 0.55, 6, 0.8, 12, 1.1],
          },
        });
        map.addLayer({
          id: 'airport-points',
          type: 'symbol',
          source: 'points',
          filter: ['==', ['get', 'point_type'], 'airport'],
          layout: {
            'icon-image': ['get', 'icon_id'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 0, 0.72, 3, 0.86, 6, 1.04, 10, 1.34, 14, 1.7],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
        });
        map.addLayer({
          id: 'site-points',
          type: 'symbol',
          source: 'points',
          filter: ['==', ['get', 'point_type'], 'site'],
          layout: {
            'icon-image': ['get', 'icon_id'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 0, 0.54, 3, 0.7, 6, 0.94, 10, 1.28, 14, 1.68],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
        });

        setIsMapReady(true);
        window.setTimeout(() => map.resize(), 0);
      } catch (error) {
        didInitLayers = false;
        setUiError('Map layers failed to load.');
        console.error(error);
      }
    };

    const handleLoad = () => {
      void initMapLayers();
    };

    const handleError = (event: { error: unknown }) => {
      console.error('MapLibre error', event.error);
    };

    map.on('load', handleLoad);
    map.on('error', handleError);

    if (map.loaded()) {
      void initMapLayers();
    }

    mapRef.current = map;
    return () => {
      map.off('load', handleLoad);
      map.off('error', handleError);
      mapRef.current = null;
      map.remove();
    };
  }, [authLoading]);

  useEffect(() => {
    if (mainView !== 'map') return;
    const map = mapRef.current;
    if (!map) return;
    const timer = window.setTimeout(() => map.resize(), 0);
    return () => window.clearTimeout(timer);
  }, [mainView]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    const theme = mapThemeTokens[themeMode];
    map.setPaintProperty('background', 'background-color', theme.background);
    map.setPaintProperty('country-fill', 'fill-color', ['coalesce', ['get', 'visit_color'], theme.countryDefault]);
    map.setPaintProperty('country-outline', 'line-color', theme.countryOutline);
    map.setPaintProperty('trip-routes-line', 'line-color', ['coalesce', ['get', 'route_color'], theme.route]);
    map.setPaintProperty('visited-states-fill', 'fill-color', ['coalesce', ['get', 'marker_color'], theme.route]);
    map.setPaintProperty('visited-states-outline', 'line-color', '#000000');
    map.setPaintProperty('selected-region-fill', 'fill-color', [
      'coalesce',
      ['get', 'selection_color'],
      theme.route,
    ]);
    map.setPaintProperty('selected-region-outline', 'line-color', '#000000');
    map.setPaintProperty('visited-states-ring', 'circle-color', ['coalesce', ['get', 'marker_color'], theme.route]);
    map.setPaintProperty('visited-states-ring', 'circle-stroke-color', [
      'coalesce',
      ['get', 'marker_stroke'],
      theme.stroke,
    ]);
    map.setPaintProperty('points', 'circle-color', ['coalesce', ['get', 'marker_color'], theme.airport]);
    map.setPaintProperty('points', 'circle-stroke-color', '#000000');
    map.setPaintProperty('osm', 'raster-saturation', theme.rasterSaturation);
    map.setPaintProperty('osm', 'raster-contrast', theme.rasterContrast);
    map.setPaintProperty('osm', 'raster-brightness-min', theme.rasterBrightnessMin);
    map.setPaintProperty('osm', 'raster-brightness-max', theme.rasterBrightnessMax);
  }, [themeMode, isMapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    try {
      const countrySource = map.getSource('countries') as maplibregl.GeoJSONSource | undefined;
      const pointSource = map.getSource('points') as maplibregl.GeoJSONSource | undefined;
      const routeSource = map.getSource('trip-routes') as maplibregl.GeoJSONSource | undefined;
      const visitedStatesSource = map.getSource('visited-states') as maplibregl.GeoJSONSource | undefined;
      if (!countrySource || !pointSource || !routeSource || !visitedStatesSource || !countryGeoRef.current || !stateGeoRef.current) {
        return;
      }

      const countryColorById = new Map<string, string>();
      activeVisits.forEach((visit) => {
        const visuals =
          isMultiProfileView
            ? profileVisualsById.get(visit.profile_id) ?? defaultVisuals
            : typeof profileId === 'number'
              ? profileVisualsById.get(profileId) ?? defaultVisuals
              : defaultVisuals;
        countryColorById.set(visit.place_id, visuals.country);
      });

      const countryFeatures = countryGeoRef.current.features.map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          visited: countryColorById.has(feature.id),
          visit_color: countryColorById.get(feature.id) ?? null,
        },
      }));
      countrySource.setData({ type: 'FeatureCollection', features: countryFeatures } as any);

      const pointFeatures = Array.from(new Map(activeVisits.map((visit) => [visit.place_id, visit])).values())
        .map((visit) => {
          const place = pointLookup.get(visit.place_id);
          if (!place || place.lat === undefined || place.lon === undefined) return null;

          const visuals =
            isMultiProfileView
              ? profileVisualsById.get(visit.profile_id) ?? defaultVisuals
              : typeof profileId === 'number'
                ? profileVisualsById.get(profileId) ?? defaultVisuals
                : defaultVisuals;
          const pointType = place.id.startsWith('city-') ? 'city' : place.id.startsWith('airport-') ? 'airport' : 'site';
          const markerColor = pointType === 'city' ? visuals.city : pointType === 'airport' ? visuals.airport : visuals.site;
          const markerStroke = contrastingColor(markerColor);

          return {
            type: 'Feature',
            id: place.id,
            geometry: { type: 'Point', coordinates: [place.lon, place.lat] },
            properties: {
              name: place.name,
              point_type: pointType,
              marker_color: markerColor,
              marker_stroke: markerStroke,
              icon_id:
                pointType === 'airport'
                  ? createAirportIconId(markerColor, markerStroke)
                  : pointType === 'site'
                    ? createSiteIconId(markerColor, markerStroke)
                    : null,
            },
          };
        })
        .filter(Boolean);

      const airportIcons = pointFeatures
        .filter(
          (feature): feature is (typeof pointFeatures)[number] & {
            properties: { point_type: string; marker_color: string; marker_stroke: string };
          } => Boolean(feature) && (feature as any).properties?.point_type === 'airport',
        )
        .map((feature) => ({
          fill: String((feature as any).properties.marker_color),
          stroke: String((feature as any).properties.marker_stroke),
        }));
      const siteIcons = pointFeatures
        .filter(
          (feature): feature is (typeof pointFeatures)[number] & {
            properties: { point_type: string; marker_color: string; marker_stroke: string };
          } => Boolean(feature) && (feature as any).properties?.point_type === 'site',
        )
        .map((feature) => ({
          fill: String((feature as any).properties.marker_color),
          stroke: String((feature as any).properties.marker_stroke),
        }));
      ensureAirportIcons(map, airportIcons);
      ensureSiteIcons(map, siteIcons);
      pointSource.setData({ type: 'FeatureCollection', features: pointFeatures } as any);

      const stateMarkerColorById = new Map<string, string>();
      activeVisits.forEach((visit) => {
        if (!visit.place_id.startsWith('state-')) return;
        const visuals =
          isMultiProfileView
            ? profileVisualsById.get(visit.profile_id) ?? defaultVisuals
            : typeof profileId === 'number'
              ? profileVisualsById.get(profileId) ?? defaultVisuals
              : defaultVisuals;
        stateMarkerColorById.set(visit.place_id, visuals.stateFill);
      });

      const stateLookup = new Map(stateGeoRef.current.features.map((feature) => [feature.id, feature] as const));
      const stateFeatures = Array.from(
        new Map(activeVisits.filter((visit) => visit.place_id.startsWith('state-')).map((visit) => [visit.place_id, visit])).values(),
      )
        .map((visit) => stateLookup.get(visit.place_id))
        .filter((feature): feature is MapFeatureCollection['features'][number] => Boolean(feature?.geometry))
        .map((feature) => {
          const markerColor = stateMarkerColorById.get(feature.id) ?? defaultVisuals.stateFill;
          return {
            type: 'Feature',
            id: feature.id,
            geometry: feature.geometry,
            properties: {
              ...feature.properties,
              marker_color: markerColor,
              marker_stroke: contrastingColor(markerColor),
            },
          };
        });
      visitedStatesSource.setData({ type: 'FeatureCollection', features: stateFeatures } as any);

      const routeFeatures: Array<Record<string, unknown>> = [];
      activeTrips.forEach((trip) => {
        const routePoints = Array.isArray(trip.route_points) ? trip.route_points : [];
        for (let index = 1; index < routePoints.length; index += 1) {
          const fromPoint = routePoints[index - 1];
          const toPoint = routePoints[index];
          if (
            typeof fromPoint?.lat !== 'number' ||
            typeof fromPoint?.lon !== 'number' ||
            typeof toPoint?.lat !== 'number' ||
            typeof toPoint?.lon !== 'number'
          ) {
            continue;
          }
          routeFeatures.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [fromPoint.lon, fromPoint.lat],
                [toPoint.lon, toPoint.lat],
              ],
            },
            properties: {
              route_color:
                isMultiProfileView
                  ? profileVisualsById.get(trip.profile_id)?.route ?? defaultVisuals.route
                  : typeof profileId === 'number'
                    ? profileVisualsById.get(profileId)?.route ?? defaultVisuals.route
                    : defaultVisuals.route,
              trip_id: trip.id,
              segment: `${fromPoint.name} -> ${toPoint.name}`,
            },
          });
        }
      });

      routeSource.setData({ type: 'FeatureCollection', features: routeFeatures } as any);
    } catch (error) {
      console.error('Failed to update map sources for the active profile.', error);
      setUiError((current) => current ?? 'Some profile data could not be drawn on the map.');
    }
  }, [activeTrips, activeVisits, defaultVisuals, isMapReady, isMultiProfileView, pointLookup, profileId, profileVisualsById]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    map.setLayoutProperty('trip-routes-line', 'visibility', showTripRoutes ? 'visible' : 'none');
  }, [isMapReady, showTripRoutes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    try {
      const selectedRegionSource = map.getSource('selected-region') as maplibregl.GeoJSONSource | undefined;
      if (!selectedRegionSource || !stateGeoRef.current) return;

      const stateLookup = new Map(stateGeoRef.current.features.map((feature) => [feature.id, feature] as const));
      const selectedStateFeature =
        selectedMapPlaceId && selectedMapPlaceId.startsWith('state-') ? stateLookup.get(selectedMapPlaceId) ?? null : null;
      const selectedStateVisuals =
        selectedStateFeature && isMultiProfileView
          ? profileVisualsById.get(stateVisitById.get(selectedStateFeature.id)?.profile_id ?? -1) ?? defaultVisuals
          : typeof profileId === 'number'
            ? profileVisualsById.get(profileId) ?? defaultVisuals
            : defaultVisuals;

      selectedRegionSource.setData({
        type: 'FeatureCollection',
        features: selectedStateFeature
          ? [
              {
                type: 'Feature',
                id: selectedStateFeature.id,
                geometry: selectedStateFeature.geometry,
                properties: {
                  ...selectedStateFeature.properties,
                  selection_color: selectedStateVisuals.selectedRegion,
                },
              },
            ]
          : [],
      } as any);
    } catch (error) {
      console.error('Failed to update selected region.', error);
    }
  }, [defaultVisuals, isMapReady, isMultiProfileView, profileId, profileVisualsById, selectedMapPlaceId, stateVisitById]);

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
      .filter((place) =>
        activeTab === 'site' && siteCategoryFilter !== 'all'
          ? (place.category || '').toLowerCase() === siteCategoryFilter
          : true,
      )
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
    siteCategoryFilter,
    sortedPlaces,
    visitedIds,
  ]);

  const MAX_VISIBLE_LIST_ITEMS = 500;
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

  const openCreateProfileModal = () => {
    setNewProfileName('');
    setNewProfilePublic(false);
    setNewProfileColor(nextSuggestedProfileColor);
    setShowCreateProfileModal(true);
  };

  const onToggleVisit = async (place: Place) => {
    if (typeof profileId !== 'number' || !canEditSelectedProfile) return;
    try {
      await api('/api/visits/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile_id: profileId,
          place_id: place.id,
          visited: !visitedIds.has(place.id),
        }),
      });
      await refreshVisitsStatsAndTrips(profileId);
    } catch {
      setUiError('Could not update visit.');
    }
  };

  const focusOnPlace = async (place: Place) => {
    const map = mapRef.current;
    if (!map) return;

    if (place.id.startsWith('country-')) {
      setSelectedMapPlaceId(null);
      const geo = countryGeoRef.current ?? (await api<MapFeatureCollection>('/api/places/geojson?type=country'));
      const feature = geo.features.find((item) => item.id === place.id);
      if (feature && fitMapToFeature(map, feature)) return;
    }

    if (place.id.startsWith('state-')) {
      setSelectedMapPlaceId(place.id);
      const geo = stateGeoRef.current ?? (await api<MapFeatureCollection>('/api/places/geojson?type=state'));
      const feature = geo.features.find((item) => item.id === place.id);
      if (feature && fitMapToFeature(map, feature, 60)) return;
    }

    setSelectedMapPlaceId(null);
    if (place.lat !== undefined && place.lon !== undefined) {
      map.flyTo({ center: [place.lon, place.lat], zoom: 5, duration: 800 });
    }
  };

  const handleCreateProfile = async (name?: string) => {
    if (!authSession?.authenticated) return;
    const candidate = (name ?? newProfileName).trim();
    if (!candidate || isProfileSubmitting) return;

    setIsProfileSubmitting(true);
    try {
      const profile = await api<Profile>('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: candidate,
          color: normalizeHexColor(newProfileColor),
          is_public: Boolean(newProfilePublic),
        }),
      });

      setNewProfileName('');
      setNewProfileColor(nextSuggestedProfileColor);
      setNewProfilePublic(false);
      setShowCreateProfileModal(false);
      await refreshProfiles();
      setProfileId(profile.id);
      setShowFirstProfilePrompt(false);
    } finally {
      setIsProfileSubmitting(false);
    }
  };

  const handleDeleteProfile = async () => {
    if (typeof profileId !== 'number' || !canEditSelectedProfile) return;
    if (!window.confirm('Delete this profile and all its visits/trip logs?')) return;

    await api(`/api/profiles/${profileId}`, { method: 'DELETE' });
    await refreshProfiles();
  };

  const handleEditProfile = async () => {
    if (typeof profileId !== 'number' || !canEditSelectedProfile) return;
    setShowEditProfileModal(true);
  };

  const handleSaveProfileEdits = async () => {
    if (typeof profileId !== 'number' || !canEditSelectedProfile || isProfileSubmitting) return;
    const currentName = editProfileName.trim();
    if (!currentName) return;
    setIsProfileSubmitting(true);
    try {
      await api(`/api/profiles/${profileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: currentName,
          color: normalizeHexColor(selectedProfileColor),
          is_public: selectedProfilePublic,
        }),
      });
      setShowEditProfileModal(false);
      await refreshProfiles();
    } finally {
      setIsProfileSubmitting(false);
    }
  };

  const handleExport = async () => {
    if (typeof profileId !== 'number') return;

    const data = await api(`/api/export?profile_id=${profileId}`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `world-visited-profile-${profileId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    if (typeof profileId !== 'number') return;

    const file = event.target.files?.[0];
    if (!file) return;

    const body = new FormData();
    body.append('file', file);

    try {
      const response = await fetch(`/api/import?profile_id=${profileId}`, { method: 'POST', body });
      if (!response.ok) {
        throw new Error('Import failed');
      }
      await refreshVisitsStatsAndTrips(profileId);
    } catch {
      setUiError('Could not import data.');
    }
  };

  const handleCreateTripLog = async () => {
    if (typeof profileId !== 'number' || !canEditSelectedProfile) return;

    const layoverIds = tripForm.layovers.map((value) => value.trim()).filter(Boolean);
    const invalidOrigin = tripForm.origin_query.trim() && !tripForm.origin_place_id;
    const invalidDestination = tripForm.destination_query.trim() && !tripForm.destination_place_id;
    const invalidLayover = tripForm.layover_queries.some((query, index) => query.trim() && !tripForm.layovers[index]);
    if (invalidOrigin || invalidDestination || invalidLayover) {
      setUiError('Please choose airports from the autocomplete list.');
      return;
    }
    if (!tripForm.origin_place_id || !tripForm.destination_place_id) {
      setUiError('Origin and destination are required for trip logs.');
      return;
    }

    try {
      await api<TripLog>('/api/trip-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile_id: profileId,
          flown_on: tripForm.flown_on || null,
          origin_place_id: tripForm.origin_place_id,
          destination_place_id: tripForm.destination_place_id,
          layover_place_ids: layoverIds,
        }),
      });

      setTripForm({
        flown_on: '',
        origin_place_id: '',
        origin_query: '',
        destination_place_id: '',
        destination_query: '',
        layovers: [''],
        layover_queries: [''],
      });
      setShowTripForm(false);
      await refreshVisitsStatsAndTrips(profileId);
    } catch {
      setUiError('Could not create trip log.');
    }
  };

  const handleDeleteTripLog = async (tripLogId: number) => {
    if (typeof profileId !== 'number' || !canEditSelectedProfile) return;
    if (!window.confirm('Delete this trip log?')) return;

    try {
      await api(`/api/trip-logs/${tripLogId}`, { method: 'DELETE' });
      await refreshVisitsStatsAndTrips(profileId);
    } catch {
      setUiError('Could not delete trip log.');
    }
  };

  const handleAdminCreateUser = async () => {
    if (!isAdmin || !newAdminUserUsername.trim() || !newAdminUserDisplayName.trim() || !newAdminUserPassword) return;
    await api('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: newAdminUserUsername.trim().toLowerCase(),
        display_name: newAdminUserDisplayName.trim(),
        password: newAdminUserPassword,
        is_admin: newAdminUserIsAdmin,
      }),
    });
    setNewAdminUserUsername('');
    setNewAdminUserDisplayName('');
    setNewAdminUserPassword('');
    setNewAdminUserIsAdmin(false);
    await refreshAdminData();
  };

  const handleAdminUserRole = async (userId: number, role: 'admin' | 'user') => {
    await api(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    await refreshAdminData();
    await refreshAuthSession();
  };

  const handleAdminSaveUser = async (userId: number) => {
    const draft = adminUserEdits[userId];
    if (!draft) return;
    await api(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: draft.username,
        display_name: draft.display_name,
      }),
    });
    await refreshAdminData();
    if (authSession?.user?.id === userId) {
      await refreshAuthSession();
    }
  };

  const handleAdminDeleteUser = async (userId: number) => {
    if (!window.confirm('Delete this user and all of their profiles?')) return;
    await api(`/api/admin/users/${userId}`, { method: 'DELETE' });
    await refreshAdminData();
  };

  const handleAdminResetPassword = async (userId: number) => {
    const password = adminPasswordReset[userId]?.trim();
    if (!password) return;
    await api(`/api/admin/users/${userId}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    setAdminPasswordReset((prev) => ({ ...prev, [userId]: '' }));
  };

  const handleAdminDeleteProfile = async (serverProfileId: number) => {
    if (!window.confirm('Delete this server profile?')) return;
    await api(`/api/admin/profiles/${serverProfileId}`, { method: 'DELETE' });
    await refreshAdminData();
    await refreshProfiles();
  };

  const handleAdminCreateProfile = async () => {
    if (!newAdminProfileName.trim() || !newAdminProfileOwnerId) return;
    await api('/api/admin/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newAdminProfileName.trim(),
        owner_user_id: Number(newAdminProfileOwnerId),
        color: normalizeHexColor(newAdminProfileColor),
        is_public: newAdminProfilePublic,
      }),
    });
    setNewAdminProfileName('');
    setNewAdminProfileOwnerId('');
    setNewAdminProfileColor(nextSuggestedProfileColor);
    setNewAdminProfilePublic(false);
    await refreshAdminData();
    await refreshProfiles();
  };

  const handleAdminEditProfile = async (serverProfile: AdminProfile) => {
    const nextName = window.prompt('Profile name', serverProfile.name);
    if (!nextName || !nextName.trim()) return;
    const nextOwner = window.prompt('Owner user id (leave blank for none)', String(serverProfile.owner_user_id ?? ''));
    const ownerUserId = nextOwner?.trim() ? Number(nextOwner.trim()) : null;
    if (ownerUserId !== null && Number.isNaN(ownerUserId)) return;
    await api(`/api/admin/profiles/${serverProfile.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: nextName.trim(),
        owner_user_id: ownerUserId,
      }),
    });
    await refreshAdminData();
    await refreshProfiles();
  };

  const handleAdminToggleProfilePublic = async (serverProfile: AdminProfile) => {
    await api(`/api/admin/profiles/${serverProfile.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_public: !serverProfile.is_public }),
    });
    await refreshAdminData();
    await refreshProfiles();
  };

  const handleAdminSaveSettings = async () => {
    if (!adminSettings) return;
    const updated = await api<AppSettings>('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adminSettings),
    });
    setAdminSettings(updated);
  };

  const handleAccountSave = async () => {
    if (!authSession?.authenticated || isAuthSubmitting) return;
    const displayName = accountDisplayName.trim();
    if (!displayName) {
      setUiError('Display name is required.');
      return;
    }
    if (accountPassword && accountPassword !== accountConfirmPassword) {
      setUiError('Password confirmation does not match.');
      return;
    }

    const payload: Record<string, string> = {
      display_name: displayName,
    };
    if (!authSession.oidc_enabled) {
      payload.username = accountUsername.trim().toLowerCase();
      if (accountPassword) {
        payload.password = accountPassword;
      }
    }

    setUiError(null);
    setIsAuthSubmitting(true);
    try {
      await api('/api/auth/account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setAccountPassword('');
      setAccountConfirmPassword('');
      await refreshAuthSession();
      if (isAdmin) {
        await refreshAdminData();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update account.';
      setUiError(message);
    } finally {
      setIsAuthSubmitting(false);
    }
  };

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

  const formatSiteCategoryLabel = (category?: string) =>
    category
      ? category
          .split('_')
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ')
      : '';

  const formatRegionLabel = (value?: string) => {
    const label = (value || '').trim();
    return label && !/^\d+$/.test(label) ? label : '';
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
      title = place.name;
      subtitle = countryName || '';
      const categoryLabel = formatSiteCategoryLabel(place.category);
      if (categoryLabel) badges.push(categoryLabel);
    }

    return { title, subtitle, badges };
  };

  const formatLeaderboardValue = (categoryId: string, value: number | undefined) => {
    if (value === undefined) return '--';
    if (categoryId === 'miles') return `${Math.round(value).toLocaleString()} mi`;
    if (categoryId === 'overall_score') return Math.round(value).toLocaleString();
    return Math.round(value).toLocaleString();
  };

  const handleLogout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      await refreshAuthSession();
      setProfiles([]);
      setProfileId(null);
      setVisits([]);
      setTripLogs([]);
      setStats(null);
      setShowSettingsOverlay(false);
    } catch {
      setUiError('Could not sign out.');
    }
  };

  const handleLocalLogin = async () => {
    const username = loginUsername.trim().toLowerCase();
    const password = loginPassword;
    if (!username || !password || isAuthSubmitting) return;
    setUiError(null);
    setIsAuthSubmitting(true);
    try {
      await api('/api/auth/local/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      setShowLoginModal(false);
      setLoginPassword('');
      await refreshAuthSession();
      await refreshProfiles();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not sign in.';
      setUiError(message);
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const handleLocalRegister = async () => {
    const username = registerUsername.trim().toLowerCase();
    const displayName = registerDisplayName.trim();
    const password = registerPassword;
    const confirm = registerConfirmPassword;
    if (!username || !displayName || !password || isAuthSubmitting) return;
    if (password !== confirm) {
      setUiError('Password confirmation does not match.');
      return;
    }
    setUiError(null);
    setIsAuthSubmitting(true);
    try {
      await api('/api/auth/local/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, display_name: displayName, password }),
      });
      await refreshAuthSession();
      await refreshProfiles();
      setRegisterPassword('');
      setRegisterConfirmPassword('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not create user.';
      setUiError(message);
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const renderSettingsBody = () => (
    <>
      <details className="settings-section" open>
        <summary>
          <div>
            <strong>Authentication</strong>
            <span>Sign in, review auth mode, and configure OIDC or backend settings.</span>
          </div>
        </summary>
        <div className="settings-section__content trip-form">
          <div className="settings-note">
            <strong>Status</strong>
            <span>
              {authSession?.authenticated
                ? `Signed in as ${authSession.user?.display_name || authSession.user?.username || authSession.user?.email || 'user'}`
                : 'Not signed in'}
            </span>
          </div>
          <div className="settings-note">
            <strong>Mode</strong>
            <span>{authSession?.oidc_enabled ? 'OIDC' : 'Local username and password'}</span>
          </div>

          {!authSession?.authenticated && authSession?.has_local_users && !authSession?.oidc_enabled && (
            <button
              type="button"
              className="accent-button"
              onClick={() => {
                setShowSettingsOverlay(false);
                setShowLoginModal(true);
              }}
            >
              Open login
            </button>
          )}

          {!authSession?.authenticated && authSession?.oidc_enabled && (
            <button
              type="button"
              className="accent-button"
              onClick={() => {
                window.location.href = '/api/auth/login';
              }}
            >
              Sign in with OIDC
            </button>
          )}

          {authSession?.authenticated && (
            <button type="button" onClick={handleLogout}>
              Log out
            </button>
          )}

          {isAdmin && adminSettings && (
            <>
              <div className="settings-subsection">
                <h3>OIDC configuration</h3>
                <label>
                  Mode
                  <select
                    value={adminSettings.auth_mode}
                    onChange={(event) =>
                      setAdminSettings((prev) => (prev ? { ...prev, auth_mode: event.target.value } : prev))
                    }
                  >
                    <option value="local">Username / password</option>
                    <option value="oidc">OIDC</option>
                  </select>
                </label>
                <label>
                  OIDC issuer
                  <input
                    value={adminSettings.oidc_issuer ?? ''}
                    onChange={(event) =>
                      setAdminSettings((prev) => (prev ? { ...prev, oidc_issuer: event.target.value } : prev))
                    }
                  />
                </label>
                <label>
                  OIDC client id
                  <input
                    value={adminSettings.oidc_client_id ?? ''}
                    onChange={(event) =>
                      setAdminSettings((prev) => (prev ? { ...prev, oidc_client_id: event.target.value } : prev))
                    }
                  />
                </label>
                <label>
                  OIDC client secret
                  <input
                    type="password"
                    value={adminSettings.oidc_client_secret ?? ''}
                    onChange={(event) =>
                      setAdminSettings((prev) => (prev ? { ...prev, oidc_client_secret: event.target.value } : prev))
                    }
                  />
                </label>
              </div>

              <div className="settings-subsection">
                <h3>Server backend</h3>
                <label>
                  Backend
                  <select
                    value={adminSettings.preferred_db_backend}
                    onChange={(event) =>
                      setAdminSettings((prev) =>
                        prev ? { ...prev, preferred_db_backend: event.target.value as 'sqlite' | 'postgres' } : prev,
                      )
                    }
                  >
                    <option value="sqlite">SQLite</option>
                    <option value="postgres">Postgres</option>
                  </select>
                </label>
                <label>
                  SQLite path
                  <input
                    value={adminSettings.sqlite_db_path ?? ''}
                    onChange={(event) =>
                      setAdminSettings((prev) => (prev ? { ...prev, sqlite_db_path: event.target.value } : prev))
                    }
                  />
                </label>
                <label>
                  DB host
                  <input
                    value={adminSettings.db_host ?? ''}
                    onChange={(event) => setAdminSettings((prev) => (prev ? { ...prev, db_host: event.target.value } : prev))}
                  />
                </label>
                <label>
                  DB port
                  <input
                    value={adminSettings.db_port ?? ''}
                    onChange={(event) => setAdminSettings((prev) => (prev ? { ...prev, db_port: event.target.value } : prev))}
                  />
                </label>
                <label>
                  DB name
                  <input
                    value={adminSettings.db_name ?? ''}
                    onChange={(event) => setAdminSettings((prev) => (prev ? { ...prev, db_name: event.target.value } : prev))}
                  />
                </label>
                <label>
                  DB user
                  <input
                    value={adminSettings.db_user ?? ''}
                    onChange={(event) => setAdminSettings((prev) => (prev ? { ...prev, db_user: event.target.value } : prev))}
                  />
                </label>
                <label>
                  DB password
                  <input
                    type="password"
                    value={adminSettings.db_password ?? ''}
                    onChange={(event) => setAdminSettings((prev) => (prev ? { ...prev, db_password: event.target.value } : prev))}
                  />
                </label>
                <small>
                  Current backend: {adminSettings.configured_db_backend}. Saving these values marks restart required.
                </small>
              </div>

              <button type="button" className="accent-button" onClick={handleAdminSaveSettings}>
                Save authentication and backend settings
              </button>
            </>
          )}
        </div>
      </details>

      <details className="settings-section">
        <summary>
          <div>
            <strong>Users</strong>
            <span>Create users, rename them, update roles, and reset passwords.</span>
          </div>
        </summary>
        <div className="settings-section__content trip-form">
          {isAdmin ? (
            <>
              <div className="settings-subsection">
                <h3>Add user</h3>
                <label>
                  Username
                  <input value={newAdminUserUsername} onChange={(event) => setNewAdminUserUsername(event.target.value)} />
                </label>
                <label>
                  Display name
                  <input value={newAdminUserDisplayName} onChange={(event) => setNewAdminUserDisplayName(event.target.value)} />
                </label>
                <label>
                  Password
                  <input type="password" value={newAdminUserPassword} onChange={(event) => setNewAdminUserPassword(event.target.value)} />
                </label>
                <label className="toggle">
                  <input type="checkbox" checked={newAdminUserIsAdmin} onChange={(event) => setNewAdminUserIsAdmin(event.target.checked)} />
                  Create as admin
                </label>
                <button type="button" className="accent-button" onClick={handleAdminCreateUser}>
                  Add user
                </button>
              </div>

              <ul className="trip-list">
                {adminUsers.map((user) => (
                  <li key={user.id} className="trip-card admin-card">
                    <div className="trip-main">
                      <strong>{user.display_name || user.username || `User ${user.id}`}</strong>
                      <span>@{user.username || 'n/a'} · {user.role}</span>
                    </div>
                    <div className="admin-actions">
                      <label>
                        Username
                        <input
                          value={adminUserEdits[user.id]?.username ?? ''}
                          onChange={(event) =>
                            setAdminUserEdits((prev) => ({
                              ...prev,
                              [user.id]: {
                                username: event.target.value,
                                display_name: prev[user.id]?.display_name ?? user.display_name ?? '',
                              },
                            }))
                          }
                        />
                      </label>
                      <label>
                        Display name
                        <input
                          value={adminUserEdits[user.id]?.display_name ?? ''}
                          onChange={(event) =>
                            setAdminUserEdits((prev) => ({
                              ...prev,
                              [user.id]: {
                                username: prev[user.id]?.username ?? user.username ?? '',
                                display_name: event.target.value,
                              },
                            }))
                          }
                        />
                      </label>
                      <button type="button" onClick={() => handleAdminSaveUser(user.id)}>
                        Save details
                      </button>
                      <button type="button" onClick={() => handleAdminUserRole(user.id, user.is_admin ? 'user' : 'admin')}>
                        {user.is_admin ? 'Demote' : 'Promote'}
                      </button>
                      <input
                        type="password"
                        placeholder="New password"
                        value={adminPasswordReset[user.id] ?? ''}
                        onChange={(event) => setAdminPasswordReset((prev) => ({ ...prev, [user.id]: event.target.value }))}
                      />
                      <button type="button" onClick={() => handleAdminResetPassword(user.id)}>
                        Reset password
                      </button>
                      <button type="button" onClick={() => handleAdminDeleteUser(user.id)}>
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>Only administrators can manage users.</p>
          )}
        </div>
      </details>

      <details className="settings-section">
        <summary>
          <div>
            <strong>List Settings</strong>
            <span>Manage list scopes, category filters, and visited-country filters.</span>
          </div>
        </summary>
        <div className="settings-section__content trip-form">
          <div className="settings-grid">
            {tabs.map((tab) => (
              <label key={`scope-${tab.type}`}>
                {tab.label} scope
                <select
                  value={listScope[tab.type]}
                  onChange={(event) =>
                    setListScope((prev) => ({
                      ...prev,
                      [tab.type]: event.target.value as ListScope,
                    }))
                  }
                >
                  {getScopeOptions(tab.type).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}

            <label>
              Site category
              <select value={siteCategoryFilter} onChange={(event) => setSiteCategoryFilter(event.target.value)}>
                {siteCategories.map((category) => (
                  <option key={category} value={category}>
                    {category === 'all' ? 'All categories' : category.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {visitedCountryScopeOptions.length > 0 && (
            <>
              <div className="visited-country-filter">
                <div className="visited-country-filter__header">
                  <span>State list country filter</span>
                  {selectedVisitedCountries.state.length > 0 && (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() =>
                        setSelectedVisitedCountries((prev) => ({
                          ...prev,
                          state: [],
                        }))
                      }
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="visited-country-filter__list">
                  {visitedCountryScopeOptions.map((country) => (
                    <label key={`state-${country.code}`} className="visited-country-option">
                      <input
                        type="checkbox"
                        checked={selectedVisitedCountries.state.includes(country.code)}
                        onChange={() => onToggleVisitedCountrySelection('state', country.code)}
                      />
                      <span>{country.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="visited-country-filter">
                <div className="visited-country-filter__header">
                  <span>City list country filter</span>
                  {selectedVisitedCountries.city.length > 0 && (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() =>
                        setSelectedVisitedCountries((prev) => ({
                          ...prev,
                          city: [],
                        }))
                      }
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="visited-country-filter__list">
                  {visitedCountryScopeOptions.map((country) => (
                    <label key={`city-${country.code}`} className="visited-country-option">
                      <input
                        type="checkbox"
                        checked={selectedVisitedCountries.city.includes(country.code)}
                        onChange={() => onToggleVisitedCountrySelection('city', country.code)}
                      />
                      <span>{country.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </details>

      <details className="settings-section">
        <summary>
          <div>
            <strong>Profile</strong>
            <span>Update your account details, display name, password, and appearance.</span>
          </div>
        </summary>
        <div className="settings-section__content trip-form">
          <label className="toggle">
            <input
              type="checkbox"
              checked={themeMode === 'light'}
              onChange={(event) => setThemeMode(event.target.checked ? 'light' : 'dark')}
            />
            Use light theme
          </label>

          {authSession?.authenticated ? (
            <>
              {!authSession.oidc_enabled && (
                <label>
                  Username
                  <input value={accountUsername} onChange={(event) => setAccountUsername(event.target.value)} />
                </label>
              )}
              <label>
                Display name
                <input value={accountDisplayName} onChange={(event) => setAccountDisplayName(event.target.value)} />
              </label>
              {!authSession.oidc_enabled && (
                <>
                  <label>
                    New password
                    <input type="password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} />
                  </label>
                  <label>
                    Confirm password
                    <input
                      type="password"
                      value={accountConfirmPassword}
                      onChange={(event) => setAccountConfirmPassword(event.target.value)}
                    />
                  </label>
                </>
              )}
              <button type="button" className="accent-button" onClick={handleAccountSave} disabled={isAuthSubmitting}>
                {isAuthSubmitting ? 'Saving...' : 'Save profile settings'}
              </button>
            </>
          ) : (
            <p>Sign in to update your account profile and password.</p>
          )}
        </div>
      </details>

      <details className="settings-section">
        <summary>
          <div>
            <strong>Map Profiles</strong>
            <span>Choose the active map profile, manage your own profiles, and administer global profiles.</span>
          </div>
        </summary>
        <div className="settings-section__content trip-form">
          <div className="settings-subsection">
            <h3>Active map profile</h3>
            <label>
              Profile
              <select
                value={profileId ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === '__create__') {
                    setShowSettingsOverlay(false);
                    openCreateProfileModal();
                  } else if (!value) {
                    setProfileId(null);
                  } else {
                    setProfileId(Number(value));
                  }
                }}
              >
                {authSession?.authenticated && <option value="__create__">+ Create profile</option>}
                <option value="">Demo mode</option>
                {ownedProfiles.length > 0 && (
                  <option value="" disabled>
                    Your profiles
                  </option>
                )}
                {ownedProfiles.map((profile) => (
                  <option key={`settings-owned-${profile.id}`} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
                {publicProfiles.length > 0 && (
                  <option value="" disabled>
                    ----------
                  </option>
                )}
                {publicProfiles.map((profile) => (
                  <option key={`settings-public-${profile.id}`} value={profile.id}>
                    {profile.name} (Public)
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-note">
              <strong>Current selection</strong>
              <span>{selectedProfile?.name ?? 'Demo mode'}</span>
            </div>
            <div className="profile-actions">
              {authSession?.authenticated && (
                <button
                  type="button"
                  onClick={() => {
                    setShowSettingsOverlay(false);
                    openCreateProfileModal();
                  }}
                >
                  Create profile
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowSettingsOverlay(false);
                  void handleEditProfile();
                }}
                disabled={typeof profileId !== 'number' || !canEditSelectedProfile}
              >
                Edit
              </button>
              <button type="button" onClick={handleDeleteProfile} disabled={typeof profileId !== 'number' || !canEditSelectedProfile}>
                Delete
              </button>
              <button type="button" onClick={handleExport} disabled={typeof profileId !== 'number'}>
                Export JSON
              </button>
              <label className="import-label">
                Import JSON
                <input
                  type="file"
                  accept="application/json"
                  onChange={handleImport}
                  disabled={typeof profileId !== 'number' || !canEditSelectedProfile}
                />
              </label>
            </div>
          </div>

          {isAdmin && (
            <div className="settings-subsection">
              <h3>Global profile management</h3>
              <label>
                Profile name
                <input value={newAdminProfileName} onChange={(event) => setNewAdminProfileName(event.target.value)} />
              </label>
              <label>
                Owner
                <select value={newAdminProfileOwnerId} onChange={(event) => setNewAdminProfileOwnerId(event.target.value)}>
                  <option value="">Select user</option>
                  {adminUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.display_name || user.username || `User ${user.id}`}
                    </option>
                  ))}
                </select>
              </label>
              {renderProfileColorField(newAdminProfileColor, setNewAdminProfileColor)}
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={newAdminProfilePublic}
                  onChange={(event) => setNewAdminProfilePublic(event.target.checked)}
                />
                Public profile
              </label>
              <button type="button" className="accent-button" onClick={handleAdminCreateProfile}>
                Create server profile
              </button>
              <ul className="trip-list">
                {adminProfiles.map((profile) => (
                  <li key={profile.id} className="trip-card admin-card">
                    <div className="trip-main">
                      <strong>{profile.name}</strong>
                      <span>{profile.owner_label || 'Unknown owner'}</span>
                    </div>
                    <div className="admin-actions">
                      <button type="button" onClick={() => handleAdminEditProfile(profile)}>
                        Edit
                      </button>
                      <button type="button" onClick={() => handleAdminToggleProfilePublic(profile)}>
                        {profile.is_public ? 'Make private' : 'Make public'}
                      </button>
                      <button type="button" onClick={() => handleAdminDeleteProfile(profile.id)}>
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </>
  );

  if (authLoading) {
    return (
      <div className="app" data-theme={themeMode}>
        <div className="first-run-modal">
          <div className="first-run-card">
            <h2>Loading</h2>
            <p>Checking authentication session.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app" data-theme={themeMode}>
      {!authSession?.authenticated && !authSession?.oidc_enabled && !authSession?.has_local_users && (
        <div className="first-run-modal">
          <div className="first-run-card">
            <h2>Create your first user</h2>
            <p>Users are required. Set up an account to unlock profile editing and tracking.</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleLocalRegister();
              }}
            >
              <input
                type="text"
                placeholder="Username"
                value={registerUsername}
                onChange={(event) => setRegisterUsername(event.target.value)}
              />
              <input
                type="text"
                placeholder="Display name"
                value={registerDisplayName}
                onChange={(event) => setRegisterDisplayName(event.target.value)}
              />
              <input
                type="password"
                placeholder="Password"
                value={registerPassword}
                onChange={(event) => setRegisterPassword(event.target.value)}
              />
              <input
                type="password"
                placeholder="Confirm password"
                value={registerConfirmPassword}
                onChange={(event) => setRegisterConfirmPassword(event.target.value)}
              />
              <button type="submit" disabled={isAuthSubmitting}>
                {isAuthSubmitting ? 'Creating...' : 'Create user'}
              </button>
            </form>
          </div>
        </div>
      )}

      {showLoginModal && !authSession?.authenticated && (
        <div className="first-run-modal">
          <div className="first-run-card">
            <h2>Log in</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleLocalLogin();
              }}
            >
              <input
                type="text"
                placeholder="Username"
                value={loginUsername}
                onChange={(event) => setLoginUsername(event.target.value)}
              />
              <input
                type="password"
                placeholder="Password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
              />
              <div className="modal-actions">
                <button type="submit" disabled={isAuthSubmitting}>
                  {isAuthSubmitting ? 'Signing in...' : 'Log in'}
                </button>
                <button type="button" onClick={() => setShowLoginModal(false)} disabled={isAuthSubmitting}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showFirstProfilePrompt && (
        <div className="first-run-modal">
          <div className="first-run-card">
            <h2>Create your first profile</h2>
            <p>Profiles are private by default. Share only if you opt in.</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreateProfile();
              }}
            >
              <input
                type="text"
                placeholder="Profile name"
                value={newProfileName}
                onChange={(event) => setNewProfileName(event.target.value)}
              />
              {renderProfileColorField(newProfileColor, setNewProfileColor)}
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={newProfilePublic}
                  onChange={(event) => setNewProfilePublic(event.target.checked)}
                />
                Share this profile publicly
              </label>
              <button type="submit" disabled={isProfileSubmitting}>
                {isProfileSubmitting ? 'Creating...' : 'Create profile'}
              </button>
            </form>
          </div>
        </div>
      )}

      {showCreateProfileModal && (
        <div className="first-run-modal">
          <div className="first-run-card">
            <h2>Create profile</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreateProfile();
              }}
            >
              <input
                type="text"
                placeholder="Profile name"
                value={newProfileName}
                onChange={(event) => setNewProfileName(event.target.value)}
              />
              {renderProfileColorField(newProfileColor, setNewProfileColor)}
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={newProfilePublic}
                  onChange={(event) => setNewProfilePublic(event.target.checked)}
                />
                Share this profile publicly
              </label>
              <div className="modal-actions">
                <button type="submit" disabled={isProfileSubmitting}>
                  {isProfileSubmitting ? 'Creating...' : 'Create'}
                </button>
                <button type="button" onClick={() => setShowCreateProfileModal(false)} disabled={isProfileSubmitting}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showEditProfileModal && selectedProfile && (
        <div className="first-run-modal">
          <div className="first-run-card">
            <h2>Edit profile</h2>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleSaveProfileEdits();
              }}
            >
              <input
                type="text"
                placeholder="Profile name"
                value={editProfileName}
                onChange={(event) => setEditProfileName(event.target.value)}
              />
              {renderProfileColorField(selectedProfileColor, setSelectedProfileColor)}
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={selectedProfilePublic}
                  onChange={(event) => setSelectedProfilePublic(event.target.checked)}
                />
                Share this profile publicly
              </label>
              <div className="modal-actions">
                <button type="submit" disabled={isProfileSubmitting}>
                  {isProfileSubmitting ? 'Saving...' : 'Save'}
                </button>
                <button type="button" onClick={() => setShowEditProfileModal(false)} disabled={isProfileSubmitting}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {uiError && <div className="ui-error">{uiError}</div>}

      <header className="header">
        <div className="brand-panel">
          <h1>AtlasTracker</h1>
          <p>Profiles, routes, stats, and shared world coverage in one atlas.</p>
          <div className="auth-controls">
            <span className="auth-user">
              {authSession?.authenticated
                ? authSession.user?.display_name || authSession.user?.username || authSession.user?.email || 'Signed in'
                : 'Not logged in'}
            </span>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setThemeMode((prev) => (prev === 'dark' ? 'light' : 'dark'))}
            >
              {themeMode === 'dark' ? 'Light' : 'Dark'}
            </button>
            <button type="button" className="theme-toggle" onClick={() => setShowSettingsOverlay(true)}>
              Settings
            </button>
            {authSession?.authenticated ? (
              <button type="button" className="theme-toggle" onClick={handleLogout}>
                Log out
              </button>
            ) : authSession?.oidc_enabled ? (
              <button type="button" className="theme-toggle" onClick={() => (window.location.href = '/api/auth/login')}>
                Log in
              </button>
            ) : (
              <button
                type="button"
                className="theme-toggle"
                onClick={() => setShowLoginModal(true)}
                disabled={!authSession?.has_local_users}
              >
                Log in
              </button>
            )}
          </div>
        </div>

        <div className="profile-panel">
          <label>
            Profile
            <select
              value={profileId ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                if (value === '__create__') {
                  openCreateProfileModal();
                } else if (!value) {
                  setProfileId(null);
                } else {
                  setProfileId(Number(value));
                }
              }}
            >
              {authSession?.authenticated && <option value="__create__">+ Create profile</option>}
              <option value="">Demo mode</option>
              {ownedProfiles.length > 0 && (
                <option value="" disabled>
                  Your profiles
                </option>
              )}
              {ownedProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
              {publicProfiles.length > 0 && (
                <option value="" disabled>
                  ----------
                </option>
              )}
              {publicProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} (Public)
                </option>
              ))}
            </select>
          </label>

          <div className="profile-actions">
            <span className="profile-actions-title">Profile actions</span>
            <button type="button" onClick={handleEditProfile} disabled={typeof profileId !== 'number' || !canEditSelectedProfile}>
              Edit
            </button>
            <button type="button" onClick={handleDeleteProfile} disabled={typeof profileId !== 'number' || !canEditSelectedProfile}>
              Delete
            </button>
            <button type="button" onClick={handleExport} disabled={typeof profileId !== 'number'}>
              Export JSON
            </button>
            <label className="import-label">
              Import JSON
              <input
                type="file"
                accept="application/json"
                onChange={handleImport}
                disabled={typeof profileId !== 'number' || !canEditSelectedProfile}
              />
            </label>
          </div>
        </div>

        <div className="profile-summary">
          <div className="summary-card">
            <span>Selected Profile</span>
            <strong>{selectedProfile?.name ?? 'Demo mode'}</strong>
            <small>
              {selectedProfile
                ? selectedProfile.is_public
                  ? 'Shared publicly'
                  : 'Private profile'
                : 'Viewing the collective server atlas'}
            </small>
          </div>
          <div className="summary-card">
            <span>Owner</span>
            <strong>{selectedProfile?.is_owned ? 'You' : selectedProfile ? 'Public view' : 'Collective server'}</strong>
            <small>{selectedProfile ? normalizeHexColor(selectedProfile.color) : 'Map colors reflect contributing profiles'}</small>
          </div>
        </div>

        <div className="highlights-rail">
          <div className="stat-card">
            <span>Countries</span>
            <strong>
              {stats?.countries.visited ?? 0} / {stats?.countries.total ?? 0}
            </strong>
            <small>{stats?.countries.percent ?? 0}% visited</small>
          </div>
          <div className="stat-card">
            <span>Trips / Miles</span>
            <strong>{stats?.trip_logs.count ?? 0}</strong>
            <small>{Math.round(stats?.trip_logs.estimated_miles ?? 0).toLocaleString()} mi total</small>
          </div>
          <div className="stat-card">
            <span>Leaderboard</span>
            <strong>
              {stats?.leaderboard.current_profile?.eligible
                ? `#${stats.leaderboard.current_profile.overall_rank ?? '--'}`
                : '--'}
            </strong>
            <small>
              {stats?.leaderboard.current_profile?.eligible
                ? `${Math.round(stats.leaderboard.current_profile.overall_score).toLocaleString()} score`
                : selectedProfile
                  ? 'Set profile public to rank'
                  : 'Public profiles only'}
            </small>
          </div>
        </div>
      </header>

      <div className="content">
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
              {(activeTab === 'state' || activeTab === 'city') && (
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
              )}
              {activeTab === 'site' && (
                <label className="scope-filter">
                  Category
                  <select value={siteCategoryFilter} onChange={(event) => setSiteCategoryFilter(event.target.value)}>
                    {siteCategories.map((category) => (
                      <option key={category} value={category}>
                        {category === 'all' ? 'All categories' : category.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {activeTab !== 'state' && activeTab !== 'city' && (
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
              )}
              {(activeTab === 'state' || activeTab === 'city') && visitedCountryScopeOptions.length > 0 && (
                <div className="visited-country-filter">
                  <div className="visited-country-filter__header">
                    <span>Visited countries</span>
                    {selectedVisitedCountries[activeTab].length > 0 && (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() =>
                          setSelectedVisitedCountries((prev) => ({
                            ...prev,
                            [activeTab]: [],
                          }))
                        }
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="visited-country-filter__list">
                    {visitedCountryScopeOptions.map((country) => (
                      <label key={country.code} className="visited-country-option">
                        <input
                          type="checkbox"
                          checked={selectedVisitedCountries[activeTab].includes(country.code)}
                          onChange={() => onToggleVisitedCountrySelection(activeTab, country.code)}
                        />
                        <span>{country.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <ul className="list">
              {visiblePlaces.map((place) => (
                <li key={place.id} className={`place-card place-card--${activeTab}${visitedIds.has(place.id) ? ' place-card--visited' : ''}`}>
                  <label className={`place-card__label${activeTab === 'city' ? ' place-card__label--compact' : ''}`}>
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
                          <span className="place-card__topline">
                            <span className={`place-name place-card__title${activeTab === 'airport' ? ' airport-name' : ''}`} onClick={() => focusOnPlace(place)}>
                              {title}
                            </span>
                            {badges.length > 0 && (
                              <span className="place-card__badges" aria-hidden="true">
                                {badges.map((badge) => (
                                  <span
                                    key={`${place.id}-${badge}`}
                                    className={`place-card__badge${activeTab === 'airport' ? ' airport-code' : ''}`}
                                  >
                                    {badge}
                                  </span>
                                ))}
                              </span>
                            )}
                          </span>
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

        <main className="map-area">
          <div className="main-tabs">
            <button
              type="button"
              className={mainView === 'map' ? 'active' : ''}
              onClick={() => setMainView('map')}
            >
              Map
            </button>
            <button
              type="button"
              className={mainView === 'trips' ? 'active' : ''}
              onClick={() => setMainView('trips')}
            >
              Trip Logs
            </button>
            <button
              type="button"
              className={mainView === 'stats' ? 'active' : ''}
              onClick={() => setMainView('stats')}
            >
              Stats
            </button>
            <button
              type="button"
              className={mainView === 'achievements' ? 'active' : ''}
              onClick={() => setMainView('achievements')}
            >
              Achievements
            </button>
            <button
              type="button"
              className={mainView === 'leaderboard' ? 'active' : ''}
              onClick={() => setMainView('leaderboard')}
            >
              Leaderboard
            </button>
          </div>

          {mainView === 'map' && (
            <div className="map-controls">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showTripRoutes}
                  onChange={(event) => setShowTripRoutes(event.target.checked)}
                />
                Show trip routes
              </label>
            </div>
          )}

          <div ref={mapContainerRef} className={`map ${mainView === 'map' ? '' : 'map-hidden'}`} />

          {mainView === 'trips' && (
            <div className="detail-panel">
              <div className="panel-header">
                <div>
                  <h3>Trip Logs</h3>
                  <p>Log origin, layovers, and destination to estimate flight miles.</p>
                </div>
                <button
                  type="button"
                  className="accent-button"
                  disabled={typeof profileId !== 'number' || !canEditSelectedProfile}
                  onClick={() => setShowTripForm((prev) => !prev)}
                >
                  {showTripForm ? 'Close form' : 'Add trip'}
                </button>
              </div>

              {showTripForm && (
                <div className="trip-form">
                  <datalist id="airport-options-origin">
                    {airportAutocomplete(tripForm.origin_query).map((airport) => (
                      <option key={airport.id} value={airportLabelById.get(airport.id) ?? ''} />
                    ))}
                  </datalist>
                  <datalist id="airport-options-destination">
                    {airportAutocomplete(tripForm.destination_query).map((airport) => (
                      <option key={airport.id} value={airportLabelById.get(airport.id) ?? ''} />
                    ))}
                  </datalist>
                  {tripForm.layover_queries.map((query, index) => (
                    <datalist id={`airport-options-layover-${index}`} key={`airport-options-${index}`}>
                      {airportAutocomplete(query).map((airport) => (
                        <option key={airport.id} value={airportLabelById.get(airport.id) ?? ''} />
                      ))}
                    </datalist>
                  ))}

                  <label>
                    Date (optional)
                    <input
                      type="date"
                      value={tripForm.flown_on}
                      onChange={(event) => setTripForm((prev) => ({ ...prev, flown_on: event.target.value }))}
                    />
                  </label>

                  <label>
                    Origin
                    <input
                      type="text"
                      list="airport-options-origin"
                      placeholder="Type code, airport name, or city/state"
                      value={tripForm.origin_query}
                      onChange={(event) => {
                        const value = event.target.value;
                        setTripForm((prev) => ({
                          ...prev,
                          origin_query: value,
                          origin_place_id: resolveAirportId(value),
                        }));
                      }}
                    />
                  </label>

                  <label>
                    Destination
                    <input
                      type="text"
                      list="airport-options-destination"
                      placeholder="Type code, airport name, or city/state"
                      value={tripForm.destination_query}
                      onChange={(event) => {
                        const value = event.target.value;
                        setTripForm((prev) => ({
                          ...prev,
                          destination_query: value,
                          destination_place_id: resolveAirportId(value),
                        }));
                      }}
                    />
                  </label>

                  {tripForm.layovers.map((layoverId, index) => (
                    <label key={`layover-${index}`}>
                      Layover {index + 1} (optional)
                      <div className="layover-row">
                        <input
                          type="text"
                          list={`airport-options-layover-${index}`}
                          placeholder="Type code, airport name, or city/state"
                          value={tripForm.layover_queries[index]}
                          onChange={(event) =>
                            setTripForm((prev) => ({
                              ...prev,
                              layovers: prev.layovers.map((item, itemIndex) =>
                                itemIndex === index ? resolveAirportId(event.target.value) : item,
                              ),
                              layover_queries: prev.layover_queries.map((item, itemIndex) =>
                                itemIndex === index ? event.target.value : item,
                              ),
                            }))
                          }
                        />
                        <button
                          type="button"
                          onClick={() =>
                            setTripForm((prev) => ({
                              ...prev,
                              layovers: prev.layovers.filter((_, itemIndex) => itemIndex !== index),
                              layover_queries: prev.layover_queries.filter(
                                (_, itemIndex) => itemIndex !== index,
                              ),
                            }))
                          }
                          disabled={tripForm.layovers.length <= 1}
                        >
                          Remove
                        </button>
                      </div>
                    </label>
                  ))}

                  <div className="trip-form-actions">
                    <button
                      type="button"
                      onClick={() =>
                        setTripForm((prev) => ({
                          ...prev,
                          layovers: [...prev.layovers, ''],
                          layover_queries: [...prev.layover_queries, ''],
                        }))
                      }
                    >
                      Add layover
                    </button>
                    <button type="button" className="accent-button" onClick={handleCreateTripLog}>
                      Save trip log
                    </button>
                  </div>
                </div>
              )}

              <ul className="trip-list">
                {tripLogs.map((trip) => (
                  <li key={trip.id} className="trip-card">
                    <div className="trip-main">
                      <strong>{trip.route_points.map((point) => point.name).join(' -> ')}</strong>
                      <span>{Math.round(trip.estimated_miles).toLocaleString()} mi estimated</span>
                      <small>{trip.flown_on ? `Date: ${trip.flown_on}` : 'Date not provided'}</small>
                    </div>
                    {typeof profileId === 'number' && canEditSelectedProfile && (
                      <button type="button" onClick={() => handleDeleteTripLog(trip.id)}>
                        Delete
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {mainView === 'stats' && (
            <div className="detail-panel">
              <div className="panel-header">
                <div>
                  <h3>Travel Stats</h3>
                  <p>Derived travel metrics from your logged trips, visits, and place metadata.</p>
                </div>
              </div>
              <TravelStatsPanel model={travelStatsModel} />
            </div>
          )}

          {mainView === 'achievements' && (
            <div className="detail-panel">
              <div className="panel-header">
                <div>
                  <h3>Achievements</h3>
                  <p>Tiered progress and milestones based on the travel data this profile already tracks.</p>
                </div>
              </div>
              <AchievementsPanel model={achievementModel} />
            </div>
          )}

          {mainView === 'leaderboard' && (
            <div className="detail-panel">
              <div className="panel-header">
                <div>
                  <h3>Leaderboard</h3>
                  <p>Public profile standings based on coverage, travel, and earned achievements.</p>
                </div>
              </div>

              <div className="stats-grid">
                <div className="stat-card">
                  <span>Your position</span>
                  <strong>
                    {stats?.leaderboard.current_profile?.eligible
                      ? `#${stats.leaderboard.current_profile.overall_rank ?? '--'}`
                      : '--'}
                  </strong>
                  <small>
                    {stats?.leaderboard.current_profile?.leader_categories?.length
                      ? `Leading: ${stats.leaderboard.current_profile.leader_categories.join(', ')}`
                      : stats?.leaderboard.current_profile?.eligible
                        ? 'No category leads yet'
                        : 'Only public profiles rank'}
                  </small>
                </div>
                <div className="stat-card">
                  <span>Public profiles</span>
                  <strong>{stats?.leaderboard.public_profile_count ?? 0}</strong>
                </div>
                <div className="stat-card">
                  <span>Country rank</span>
                  <strong>
                    {stats?.leaderboard.current_profile?.eligible
                      ? `#${stats.leaderboard.current_profile.country_rank ?? '--'}`
                      : '--'}
                  </strong>
                </div>
                <div className="stat-card">
                  <span>Achievement rank</span>
                  <strong>
                    {stats?.leaderboard.current_profile?.eligible
                      ? `#${stats.leaderboard.current_profile.achievement_rank ?? '--'}`
                      : '--'}
                  </strong>
                </div>
              </div>

              <div className="leaderboard-grid">
                <section className="leaderboard-panel">
                  <div className="panel-header">
                    <div>
                      <h3>Overall</h3>
                      <p>Weighted score across coverage, travel, and achievements.</p>
                    </div>
                  </div>
                  <div className="leaderboard-list">
                    {(stats?.leaderboard.top_overall ?? []).map((entry, index) => (
                      <div key={entry.profile_id} className="leaderboard-row">
                        <span className="leaderboard-rank">#{index + 1}</span>
                        <div>
                          <strong>{entry.name}</strong>
                          <small>
                            {entry.countries ?? 0} countries | {Math.round(entry.miles ?? 0).toLocaleString()} mi |{' '}
                            {entry.achievements ?? 0} achievements
                          </small>
                        </div>
                        <span>{Math.round(entry.overall_score ?? 0).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </section>

                {(stats?.leaderboard.categories ?? []).map((category) => (
                  <section className="leaderboard-panel" key={category.id}>
                    <div className="panel-header">
                      <div>
                        <h3>{category.label}</h3>
                        <p>Current public leaders in this category.</p>
                      </div>
                    </div>
                    <div className="leaderboard-list">
                      {category.leaders.map((entry, index) => (
                        <div key={`${category.id}-${entry.profile_id}`} className="leaderboard-row">
                          <span className="leaderboard-rank">#{index + 1}</span>
                          <strong>{entry.name}</strong>
                          <span>{formatLeaderboardValue(category.id, entry.value)}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          )}

        </main>
      </div>

      {showSettingsOverlay && (
        <div className="first-run-modal settings-modal">
          <div className="first-run-card settings-card">
            <div className="settings-card__header">
              <div>
                <h2>Settings</h2>
                <p>Account, application, and server configuration.</p>
              </div>
              <button type="button" onClick={() => setShowSettingsOverlay(false)}>
                Close
              </button>
            </div>
            <div className="settings-card__body">{renderSettingsBody()}</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
