export type PlaceType = 'country' | 'state' | 'city' | 'airport' | 'site';
export type ActiveProfile = number | null;
export type ListScope = 'all' | 'visited' | 'unvisited' | 'visited_countries';
export type MainView = 'map' | 'trips' | 'stats' | 'achievements' | 'leaderboard';
export type MeasurementSystem = 'metric' | 'imperial';
export type ThemeMode = 'dark' | 'light';
export type MapLabelLanguage = 'local' | 'english';

export type Place = {
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
  sourceType?: string | null;
  alternateNames?: string[];
  countryOrCountries?: string[];
  region?: string | null;
  cityOrLocality?: string | null;
  latitude?: number;
  longitude?: number;
  summary?: string | null;
  tags?: string[];
  type?: string | null;
  metadata?: Record<string, unknown>;
};

export type PlacesResponse = {
  items: Place[];
  total?: number | null;
  limit: number;
  offset: number;
  has_more?: boolean;
  next_offset?: number;
};

export type Visit = {
  profile_id: number;
  place_id: string;
  visited_at?: string | null;
  trip_id?: string | null;
};

export type TripLog = {
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

export type Measurement = {
  id: string;
  label: string;
  place_name: string;
  value: number | string;
  display_value: string;
  detail?: string | null;
  unit?: string | null;
};

export type Achievement = {
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

export type LeaderboardProfile = {
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

export type Stats = {
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

export type Profile = {
  id: number;
  name: string;
  color: string;
  home_country_code?: string | null;
  is_public: boolean;
  is_owned: boolean;
  owner_user_id?: number | null;
};

export type AuthSession = {
  oidc_enabled: boolean;
  authenticated: boolean;
  auth_mode?: 'oidc' | 'local';
  local_users_count?: number;
  has_local_users?: boolean;
  user?: {
    id: number;
    username?: string | null;
    email?: string | null;
    display_name?: string | null;
    role?: 'admin' | 'user';
    is_admin?: boolean;
    theme_preference?: ThemeMode;
    measurement_system?: MeasurementSystem;
    default_profile_id?: number | null;
  } | null;
};

export type AppSettings = {
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

export type AdminUser = {
  id: number;
  username?: string | null;
  email?: string | null;
  display_name?: string | null;
  role: 'admin' | 'user';
  is_admin: boolean;
};

export type AdminProfile = Profile & {
  owner_label?: string;
};

export type AdminProfileEdit = {
  name: string;
  owner_user_id: string;
  color: string;
  home_country_code: string;
  is_public: boolean;
};

export type MapFeatureCollection = {
  type: 'FeatureCollection';
  features: Array<{
    id: string;
    geometry: any;
    properties: Record<string, unknown>;
  }>;
};

export type SiteSourceType = 'unesco' | 'dark_sky' | 'festival' | 'michelin';
export type SiteFilterState = {
  sourceType: string;
  category: string;
  country: string;
};
