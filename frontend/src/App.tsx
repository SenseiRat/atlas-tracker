import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { LngLatBoundsLike, Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

type PlaceType = 'country' | 'city' | 'airport' | 'site';
type ActiveProfile = number | 'all' | null;

type Place = {
  id: string;
  name: string;
  country_code?: string;
  lat?: number;
  lon?: number;
};

type Visit = {
  profile_id: number;
  place_id: string;
  visited_at?: string | null;
  trip_id?: string | null;
};

type Stats = {
  countries: { visited: number; total: number; percent: number };
  cities: { visited: number; total: number };
  airports: { visited: number; total: number };
  sites: { visited: number; total: number };
};

type Profile = { id: number; name: string };

const tabs: { type: PlaceType; label: string; helper: string }[] = [
  { type: 'country', label: 'Countries', helper: 'Track country coverage.' },
  { type: 'city', label: 'Major Cities', helper: 'Curated fast list.' },
  { type: 'airport', label: 'Major Airports', helper: 'Medium + large hubs.' },
  { type: 'site', label: 'World Heritage Sites', helper: 'Curated top sights.' },
];

const profilePalette = ['#22c55e', '#f97316', '#38bdf8', '#e879f9', '#facc15', '#fb7185'];
const pointTypeColor: Record<PlaceType, string> = {
  country: '#22c55e',
  city: '#38bdf8',
  airport: '#f97316',
  site: '#e879f9',
};

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
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-opacity': 0.9 },
    },
  ],
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function App() {
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const countryGeoRef = useRef<any>(null);

  const [activeTab, setActiveTab] = useState<PlaceType>('country');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<ActiveProfile>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [places, setPlaces] = useState<Record<PlaceType, Place[]>>({ country: [], city: [], airport: [], site: [] });
  const [visits, setVisits] = useState<Visit[]>([]);
  const [newProfileName, setNewProfileName] = useState('');
  const [showFirstProfilePrompt, setShowFirstProfilePrompt] = useState(false);
  const [search, setSearch] = useState<Record<PlaceType, string>>({ country: '', city: '', airport: '', site: '' });
  const [visitedOnly, setVisitedOnly] = useState<Record<PlaceType, boolean>>({ country: false, city: false, airport: false, site: false });

  const profileColorById = useMemo(() => {
    const map = new Map<number, string>();
    profiles.forEach((profile, index) => map.set(profile.id, profilePalette[index % profilePalette.length]));
    return map;
  }, [profiles]);

  const refreshProfiles = async () => {
    const data = await api<Profile[]>('/api/profiles');
    setProfiles(data);
    if (data.length === 0) {
      setProfileId(null);
      setShowFirstProfilePrompt(true);
    } else if (profileId === null) {
      setProfileId(data[0].id);
      setShowFirstProfilePrompt(false);
    } else if (typeof profileId === 'number' && !data.some((p) => p.id === profileId)) {
      setProfileId(data[0].id);
    }
  };

  const refreshVisitsAndStats = async (active: ActiveProfile) => {
    if (active === null) {
      setVisits([]);
      setStats(null);
      return;
    }
    const visitsPath = active === 'all' ? '/api/visits' : `/api/visits?profile_id=${active}`;
    const statsPath = active === 'all' ? '/api/stats' : `/api/stats?profile_id=${active}`;
    const [visitData, statsData] = await Promise.all([api<Visit[]>(visitsPath), api<Stats>(statsPath)]);
    setVisits(visitData);
    setStats(statsData);
  };

  useEffect(() => {
    refreshProfiles().catch(() => setProfiles([]));
  }, []);

  useEffect(() => {
    refreshVisitsAndStats(profileId).catch(() => {
      setVisits([]);
      setStats(null);
    });
  }, [profileId]);

  useEffect(() => {
    tabs.forEach(async (tab) => {
      const response = await api<{ items: Place[] }>(`/api/places?type=${tab.type}&limit=10000`);
      setPlaces((prev) => ({ ...prev, [tab.type]: response.items }));
    });
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: baseStyle as any,
      center: [10, 25],
      zoom: 1.4,
      maxZoom: 7,
      minZoom: 1,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    map.on('load', async () => {
      const countryGeo = await api(`/api/places/geojson?type=country`);
      countryGeoRef.current = countryGeo;
      map.addSource('countries', { type: 'geojson', data: countryGeo as any });
      map.addLayer({
        id: 'country-fill',
        type: 'fill',
        source: 'countries',
        paint: {
          'fill-color': ['coalesce', ['get', 'visit_color'], '#334155'],
          'fill-opacity': ['case', ['boolean', ['get', 'visited'], false], 0.55, 0.15],
        },
      });
      map.addLayer({
        id: 'country-outline',
        type: 'line',
        source: 'countries',
        paint: { 'line-color': '#0f172a', 'line-width': 1 },
      });

      map.addSource('points', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] } as any,
        cluster: true,
        clusterMaxZoom: 5,
        clusterRadius: 40,
      });
      map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'points',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#38bdf8',
          'circle-radius': ['step', ['get', 'point_count'], 12, 8, 18, 30, 24],
        },
      });
      map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'points',
        filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12 },
      });
      map.addLayer({
        id: 'points',
        type: 'circle',
        source: 'points',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': [
            'case',
            ['==', ['get', 'point_type'], 'city'], '#38bdf8',
            ['==', ['get', 'point_type'], 'airport'], '#f97316',
            ['==', ['get', 'point_type'], 'site'], '#e879f9',
            '#f97316',
          ],
          'circle-radius': 6,
          'circle-stroke-color': ['coalesce', ['get', 'profile_color'], '#0f172a'],
          'circle-stroke-width': 1,
        },
      });
    });

    mapRef.current = map;
    return () => map.remove();
  }, []);

  const visitedIds = useMemo(() => {
    if (profileId === 'all') {
      return new Set(visits.map((v) => v.place_id));
    }
    return new Set(visits.filter((v) => v.profile_id === profileId).map((v) => v.place_id));
  }, [visits, profileId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const countrySource = map.getSource('countries') as maplibregl.GeoJSONSource | undefined;
    const pointSource = map.getSource('points') as maplibregl.GeoJSONSource | undefined;
    if (!countrySource || !pointSource || !countryGeoRef.current) return;

    const countryColorById = new Map<string, string>();

    const activeVisits =
      profileId === 'all' ? visits : visits.filter((visit) => visit.profile_id === profileId);

    activeVisits.forEach((visit) => {
      const color =
        profileId === 'all'
          ? profileColorById.get(visit.profile_id) ?? '#22c55e'
          : '#22c55e';
      countryColorById.set(visit.place_id, color);
    });

    const countryFeatures = countryGeoRef.current.features.map((feature: any) => ({
      ...feature,
      properties: {
        ...feature.properties,
        visited: countryColorById.has(feature.id),
        visit_color: countryColorById.get(feature.id) ?? null,
      },
    }));

    countrySource.setData({ type: 'FeatureCollection', features: countryFeatures } as any);

    const pointLookup = new Map(
      ['city', 'airport', 'site']
        .flatMap((type) => places[type as PlaceType])
        .map((place) => [place.id, place]),
    );

    const pointFeatures = activeVisits
      .map((visit) => {
        const place = pointLookup.get(visit.place_id);
        if (!place || place.lat === undefined || place.lon === undefined) return null;
        const profileColor =
          profileId === 'all'
            ? profileColorById.get(visit.profile_id) ?? '#f97316'
            : '#0f172a';
        const pointType = place.id.startsWith('city-')
          ? 'city'
          : place.id.startsWith('airport-')
            ? 'airport'
            : 'site';
        return {
          type: 'Feature',
          id: place.id,
          geometry: { type: 'Point', coordinates: [place.lon, place.lat] },
          properties: {
            name: place.name,
            point_type: pointType,
            point_color: pointTypeColor[pointType],
            profile_color: profileColor,
          },
        };
      })
      .filter(Boolean);

    pointSource.setData({ type: 'FeatureCollection', features: pointFeatures } as any);
  }, [places, visits, profileId, profileColorById]);

  const filteredPlaces = useMemo(
    () =>
      tabs.reduce((acc, tab) => {
        const term = search[tab.type].toLowerCase();
        acc[tab.type] = places[tab.type]
          .filter((place) => place.name.toLowerCase().includes(term))
          .filter((place) => (visitedOnly[tab.type] ? visitedIds.has(place.id) : true))
          .sort((a, b) => a.name.localeCompare(b.name));
        return acc;
      }, {} as Record<PlaceType, Place[]>),
    [places, search, visitedOnly, visitedIds],
  );

  const onToggleVisit = async (place: Place) => {
    if (typeof profileId !== 'number') return;
    await api('/api/visits/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId, place_id: place.id, visited: !visitedIds.has(place.id) }),
    });
    await refreshVisitsAndStats(profileId);
  };

  const focusOnPlace = async (place: Place) => {
    const map = mapRef.current;
    if (!map) return;
    if (place.id.startsWith('country-')) {
      const geo = countryGeoRef.current ?? (await api(`/api/places/geojson?type=country`));
      const feature = (geo as any).features.find((item: any) => item.id === place.id);
      if (!feature) return;
      const bounds = new maplibregl.LngLatBounds();
      const collectCoords = (coords: any) => {
        coords.forEach((coord: any) => {
          if (typeof coord[0] === 'number') {
            bounds.extend(coord as [number, number]);
          } else {
            collectCoords(coord);
          }
        });
      };
      collectCoords(feature.geometry.coordinates);
      map.fitBounds(bounds as LngLatBoundsLike, { padding: 40, duration: 800 });
    } else if (place.lat !== undefined && place.lon !== undefined) {
      map.flyTo({ center: [place.lon, place.lat], zoom: 5, duration: 800 });
    }
  };

  const handleCreateProfile = async (name?: string) => {
    const candidate = (name ?? newProfileName).trim();
    if (!candidate) return;
    const profile = await api<Profile>('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: candidate }),
    });
    setNewProfileName('');
    await refreshProfiles();
    setProfileId(profile.id);
    setShowFirstProfilePrompt(false);
  };

  const handleDeleteProfile = async () => {
    if (typeof profileId !== 'number') return;
    if (!window.confirm('Delete this profile and all its visits?')) return;
    await api(`/api/profiles/${profileId}`, { method: 'DELETE' });
    await refreshProfiles();
  };

  const handleEditProfile = async () => {
    if (typeof profileId !== 'number') return;
    const current = profiles.find((profile) => profile.id === profileId);
    const nextName = window.prompt('Rename profile', current?.name ?? '');
    if (!nextName || !nextName.trim()) return;
    await api(`/api/profiles/${profileId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nextName.trim() }),
    });
    await refreshProfiles();
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
    await fetch(`/api/import?profile_id=${profileId}`, { method: 'POST', body });
    await refreshVisitsAndStats(profileId);
  };

  return (
    <div className="app">
      {showFirstProfilePrompt && (
        <div className="first-run-modal">
          <div className="first-run-card">
            <h2>Welcome 👋</h2>
            <p>Name your first profile to get started.</p>
            <input
              type="text"
              placeholder="Your name"
              value={newProfileName}
              onChange={(event) => setNewProfileName(event.target.value)}
            />
            <button type="button" onClick={() => handleCreateProfile()}>
              Create profile
            </button>
          </div>
        </div>
      )}

      <header className="header">
        <div>
          <h1>World Visited Tracker</h1>
          <p>Track countries, cities, airports, and sites with profile-aware mapping.</p>
        </div>
        <div className="profile-controls">
          <label>
            Profile
            <select
              value={profileId ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'all') setProfileId('all');
                else if (value) setProfileId(Number(value));
              }}
            >
              {profiles.length > 0 && <option value="all">All Profiles</option>}
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>

          <div className="profile-create">
            <input
              type="text"
              placeholder="New profile"
              value={newProfileName}
              onChange={(event) => setNewProfileName(event.target.value)}
            />
            <button type="button" onClick={() => handleCreateProfile()}>
              Add
            </button>
          </div>

          <div className="profile-actions">
            <span className="profile-actions-title">Profile actions</span>
            <button type="button" onClick={handleEditProfile} disabled={typeof profileId !== 'number'}>
              Edit
            </button>
            <button type="button" onClick={handleDeleteProfile} disabled={typeof profileId !== 'number'}>
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
                disabled={typeof profileId !== 'number'}
              />
            </label>
          </div>

          {profileId === 'all' && (
            <div className="legend">
              {profiles.map((profile) => (
                <div key={profile.id} className="legend-item">
                  <span style={{ backgroundColor: profileColorById.get(profile.id) }} />
                  {profile.name}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="stats">
          <div className="stat-card">
            <span>Countries</span>
            <strong>
              {stats?.countries.visited ?? 0} / {stats?.countries.total ?? 0}
            </strong>
            <small>{stats?.countries.percent ?? 0}% world visited</small>
          </div>
          <div className="stat-card">
            <span>Cities</span>
            <strong>{stats?.cities.visited ?? 0}</strong>
          </div>
          <div className="stat-card">
            <span>Airports</span>
            <strong>{stats?.airports.visited ?? 0}</strong>
          </div>
          <div className="stat-card">
            <span>Sites</span>
            <strong>{stats?.sites.visited ?? 0}</strong>
          </div>
        </div>
      </header>

      <div className="content">
        <aside className="sidebar">
          <div className="tabs">
            {tabs.map((tab) => (
              <button key={tab.type} className={activeTab === tab.type ? 'active' : ''} onClick={() => setActiveTab(tab.type)}>
                {tab.label}
              </button>
            ))}
          </div>

          <div className="tab-panel">
            <div className="tab-meta">
              <h2>{tabs.find((tab) => tab.type === activeTab)?.label}</h2>
              <p>{tabs.find((tab) => tab.type === activeTab)?.helper}</p>
            </div>

            <div className="filters">
              <input
                type="search"
                placeholder={`Search ${activeTab}...`}
                value={search[activeTab]}
                onChange={(event) => setSearch((prev) => ({ ...prev, [activeTab]: event.target.value }))}
              />
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={visitedOnly[activeTab]}
                  onChange={(event) => setVisitedOnly((prev) => ({ ...prev, [activeTab]: event.target.checked }))}
                />
                Visited only
              </label>
            </div>

            <ul className="list">
              {filteredPlaces[activeTab].map((place) => (
                <li key={place.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={visitedIds.has(place.id)}
                      disabled={typeof profileId !== 'number'}
                      onChange={() => onToggleVisit(place)}
                    />
                    <span className="place-name" onClick={() => focusOnPlace(place)}>
                      {place.name}
                    </span>
                    {place.country_code && <span>{place.country_code}</span>}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <main className="map-area">
          <div ref={mapContainerRef} className="map" />
        </main>
      </div>
    </div>
  );
}

export default App;
