import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { LngLatBoundsLike, Map } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

type PlaceType = 'country' | 'city' | 'airport' | 'site';

type Place = {
  id: string;
  name: string;
  country_code?: string;
  lat?: number;
  lon?: number;
  data?: string;
};

type Visit = {
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

type TabConfig = {
  type: PlaceType;
  label: string;
  helper: string;
};

const tabs: TabConfig[] = [
  { type: 'country', label: 'Countries', helper: 'Color the map as you go.' },
  { type: 'city', label: 'Major Cities', helper: 'Top 1000 by population.' },
  { type: 'airport', label: 'Major Airports', helper: 'Large + medium airports.' },
  { type: 'site', label: 'World Heritage Sites', helper: 'Curated starter list.' },
];

const baseStyle = {
  version: 8,
  name: 'Blank',
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#0f172a' },
    },
  ],
};

const API_BASE = '';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function App() {
  const mapRef = useRef<Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const [activeTab, setActiveTab] = useState<PlaceType>('country');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [places, setPlaces] = useState<Record<PlaceType, Place[]>>({
    country: [],
    city: [],
    airport: [],
    site: [],
  });
  const [visits, setVisits] = useState<Visit[]>([]);
  const [search, setSearch] = useState<Record<PlaceType, string>>({
    country: '',
    city: '',
    airport: '',
    site: '',
  });
  const [visitedOnly, setVisitedOnly] = useState<Record<PlaceType, boolean>>({
    country: false,
    city: false,
    airport: false,
    site: false,
  });
  const countryGeoRef = useRef<any>(null);
  const [newProfileName, setNewProfileName] = useState('');
  const visitedIds = useMemo(() => new Set(visits.map((visit) => visit.place_id)), [visits]);

  useEffect(() => {
    api<Profile[]>('/api/profiles')
      .then((data) => {
        setProfiles(data);
        if (data.length && profileId === null) {
          setProfileId(data[0].id);
        }
      })
      .catch(() => {
        setProfiles([]);
      });
  }, [profileId]);

  useEffect(() => {
    if (!profileId) return;
    api<Visit[]>(`/api/visits?profile_id=${profileId}`).then(setVisits);
    api<Stats>(`/api/stats?profile_id=${profileId}`).then(setStats);
  }, [profileId]);

  useEffect(() => {
    const loadPlaces = async (type: PlaceType) => {
      const response = await api<{ items: Place[] }>(`/api/places?type=${type}&limit=10000`);
      setPlaces((prev) => ({ ...prev, [type]: response.items }));
    };
    tabs.forEach((tab) => {
      loadPlaces(tab.type);
    });
  }, []);

  useEffect(() => {
    if (!mapContainerRef.current) return;
    if (mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: baseStyle,
      center: [0, 20],
      zoom: 1.2,
      maxZoom: 5,
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
          'fill-color': [
            'case',
            ['boolean', ['feature-state', 'visited'], false],
            '#22c55e',
            '#1e293b',
          ],
          'fill-opacity': 0.7,
        },
      });
      map.addLayer({
        id: 'country-outline',
        type: 'line',
        source: 'countries',
        paint: {
          'line-color': '#334155',
          'line-width': 1,
        },
      });

      const pointGeo = await api(`/api/places/geojson?type=city`);
      map.addSource('points', {
        type: 'geojson',
        data: pointGeo as any,
        cluster: true,
        clusterMaxZoom: 4,
        clusterRadius: 40,
      });

      map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'points',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#38bdf8',
          'circle-radius': ['step', ['get', 'point_count'], 12, 10, 18, 30, 26],
          'circle-opacity': 0.8,
        },
      });

      map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'points',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-size': 12,
        },
        paint: {
          'text-color': '#0f172a',
        },
      });

      map.addLayer({
        id: 'points',
        type: 'circle',
        source: 'points',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': '#f97316',
          'circle-radius': 5,
          'circle-stroke-color': '#0f172a',
          'circle-stroke-width': 1,
        },
      });
    });

    mapRef.current = map;
    return () => map.remove();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const source = map.getSource('points') as maplibregl.GeoJSONSource | undefined;
    if (!source) return;

    const pointFeatures = ['city', 'airport', 'site']
      .flatMap((type) => places[type as PlaceType])
      .filter((place) => visitedIds.has(place.id))
      .map((place) => ({
        type: 'Feature',
        id: place.id,
        geometry: {
          type: 'Point',
          coordinates: [place.lon, place.lat],
        },
        properties: {
          name: place.name,
          category: place.id.split('-')[0],
        },
      }));

    source.setData({ type: 'FeatureCollection', features: pointFeatures } as any);
  }, [places, visitedIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const countrySource = map.getSource('countries') as maplibregl.GeoJSONSource | undefined;
    if (!countrySource) return;
    const features = countryGeoRef.current?.features ?? [];
    features.forEach((feature: any) => {
      map.setFeatureState(
        { source: 'countries', id: feature.id },
        { visited: visitedIds.has(feature.id) }
      );
    });
  }, [visitedIds]);

  const onToggleVisit = async (place: Place) => {
    if (!profileId) return;
    const visited = visitedIds.has(place.id);
    await api('/api/visits/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile_id: profileId,
        place_id: place.id,
        visited: !visited,
      }),
    });
    const [newVisits, newStats] = await Promise.all([
      api<Visit[]>(`/api/visits?profile_id=${profileId}`),
      api<Stats>(`/api/stats?profile_id=${profileId}`),
    ]);
    setVisits(newVisits);
    setStats(newStats);
  };

  const filteredPlaces = useMemo(() => {
    return tabs.reduce((acc, tab) => {
      const searchTerm = search[tab.type].toLowerCase();
      const filtered = places[tab.type]
        .filter((place) => place.name.toLowerCase().includes(searchTerm))
        .filter((place) => (visitedOnly[tab.type] ? visitedIds.has(place.id) : true))
        .sort((a, b) => a.name.localeCompare(b.name));
      acc[tab.type] = filtered;
      return acc;
    }, {} as Record<PlaceType, Place[]>);
  }, [places, search, visitedOnly, visitedIds]);

  const focusOnPlace = async (place: Place) => {
    const map = mapRef.current;
    if (!map) return;
    if (place.id.startsWith('country-')) {
      const geo = countryGeoRef.current ?? (await api(`/api/places/geojson?type=country`));
      const feature = (geo as any).features.find((item: any) => item.id === place.id);
      if (feature) {
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
      }
    } else if (place.lat && place.lon) {
      map.flyTo({ center: [place.lon, place.lat], zoom: 4, duration: 800 });
    }
  };

  const handleExport = async () => {
    if (!profileId) return;
    const data = await api(`/api/export?profile_id=${profileId}`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `world-visited-profile-${profileId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!profileId) return;
    const file = event.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    await fetch(`/api/import?profile_id=${profileId}`, {
      method: 'POST',
      body: formData,
    });
    const [newVisits, newStats] = await Promise.all([
      api<Visit[]>(`/api/visits?profile_id=${profileId}`),
      api<Stats>(`/api/stats?profile_id=${profileId}`),
    ]);
    setVisits(newVisits);
    setStats(newStats);
  };

  const handleCreateProfile = async () => {
    if (!newProfileName.trim()) return;
    const profile = await api<Profile>('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newProfileName }),
    });
    setProfiles((prev) => [...prev, profile].sort((a, b) => a.name.localeCompare(b.name)));
    setProfileId(profile.id);
    setNewProfileName('');
  };

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>World Visited Tracker</h1>
          <p>Keep a beautifully simple log of where you have been.</p>
        </div>
        <div className="profile-controls">
          <label>
            Profile
            <select
              value={profileId ?? ''}
              onChange={(event) => setProfileId(Number(event.target.value))}
            >
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
            <button type="button" onClick={handleCreateProfile}>
              Add
            </button>
          </div>
          <div className="profile-actions">
            <button type="button" onClick={handleExport}>
              Export JSON
            </button>
            <label className="import-label">
              Import JSON
              <input type="file" accept="application/json" onChange={handleImport} />
            </label>
          </div>
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
              <p>{tabs.find((tab) => tab.type === activeTab)?.helper}</p>
            </div>
            <div className="filters">
              <input
                type="search"
                placeholder={`Search ${activeTab}...`}
                value={search[activeTab]}
                onChange={(event) =>
                  setSearch((prev) => ({ ...prev, [activeTab]: event.target.value }))
                }
              />
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={visitedOnly[activeTab]}
                  onChange={(event) =>
                    setVisitedOnly((prev) => ({ ...prev, [activeTab]: event.target.checked }))
                  }
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
          <div ref={mapContainerRef} className="map"></div>
        </main>
      </div>
    </div>
  );
}

export default App;
