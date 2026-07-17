import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import maplibregl, { Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api } from '../../api/client';
import { contrastingColor, createProfileVisuals, defaultProfileColor, mixHexColors } from '../../lib/colors';
import { getSiteSourceConfig } from '../../lib/sites';
import type { ActiveProfile, MainView, MapFeatureCollection, MapLabelLanguage, Place, ThemeMode, TripLog, Visit } from '../../types';
import {
  baseStyle,
  basemapTilesByLabelLanguage,
  mapThemeTokens,
  emptyFeatureCollection,
  fitMapToFeature,
  ensureAirportIcons,
  ensureSiteIcons,
  ensureFestivalIcons,
  createAirportIconId,
  createSiteIconId,
  createFestivalIconId,
} from './mapStyle';

export type MapViewHandle = {
  focusOnPlace: (place: Place) => Promise<void>;
};

type ProfileVisuals = ReturnType<typeof createProfileVisuals>;

type MapViewProps = {
  authLoading: boolean;
  themeMode: ThemeMode;
  mapLabelLanguage: MapLabelLanguage;
  mainView: MainView;
  showTripRoutes: boolean;
  profileId: ActiveProfile;
  isMultiProfileView: boolean;
  activeVisits: Visit[];
  activeTrips: TripLog[];
  profileVisualsById: Map<number, ProfileVisuals>;
  pointLookup: Map<string, Place>;
  stateVisitById: Map<string, Visit>;
  selectedMapPlaceId: string | null;
  setSelectedMapPlaceId: (id: string | null) => void;
  setUiError: (message: string | null) => void;
};

/**
 * The MapLibre map: owns the map instance (init-once guard for StrictMode
 * double-mounts), layer/source setup, and all map-updating effects. Exposes
 * focusOnPlace through the forwarded ref so list clicks can drive the map.
 */
export const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(
  {
    authLoading,
    themeMode,
    mapLabelLanguage,
    mainView,
    showTripRoutes,
    profileId,
    isMultiProfileView,
    activeVisits,
    activeTrips,
    profileVisualsById,
    pointLookup,
    stateVisitById,
    selectedMapPlaceId,
    setSelectedMapPlaceId,
    setUiError,
  },
  ref,
) {
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const countryGeoRef = useRef<MapFeatureCollection | null>(null);
  const stateGeoRef = useRef<MapFeatureCollection | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const defaultVisuals = useMemo(() => createProfileVisuals(defaultProfileColor, themeMode), [themeMode]);

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
        // The atlas is a flat north-up map: no rotate/pitch anywhere.
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });
    } catch (error) {
      setUiError('Map failed to initialize.');
      console.error(error);
      return;
    }

    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();

    // Right-button drag pans the map (instead of the MapLibre default of
    // rotating/pitching it).
    const canvas = map.getCanvas();
    let rightDragPoint: { x: number; y: number } | null = null;
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 2) return;
      event.preventDefault();
      rightDragPoint = { x: event.clientX, y: event.clientY };
    };
    const onMouseMove = (event: MouseEvent) => {
      if (!rightDragPoint || !mapRef.current) return;
      const dx = rightDragPoint.x - event.clientX;
      const dy = rightDragPoint.y - event.clientY;
      rightDragPoint = { x: event.clientX, y: event.clientY };
      mapRef.current.panBy([dx, dy], { duration: 0 });
    };
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 2) rightDragPoint = null;
    };
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

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
          setUiError('State overlays could not be loaded.');
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

        const selectFeatureFromLayer = (event: maplibregl.MapLayerMouseEvent) => {
          const featureId = event.features?.[0]?.id;
          if (typeof featureId === 'string') {
            setSelectedMapPlaceId(featureId);
          }
        };
        map.on('click', 'airport-points', selectFeatureFromLayer);
        map.on('click', 'site-points', selectFeatureFromLayer);
        map.on('click', 'points', selectFeatureFromLayer);

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
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
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
    const container = mapContainerRef.current;
    if (!map || !container || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      map.resize();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
    };
  }, [isMapReady]);

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
          const sourceConfig = pointType === 'site' ? getSiteSourceConfig(place) : null;
          const markerColor =
            pointType === 'city'
              ? visuals.city
              : pointType === 'airport'
                ? visuals.airport
                : mixHexColors(visuals.site, sourceConfig?.themeColor[themeMode] ?? visuals.site, 0.55);
          const markerStroke = contrastingColor(markerColor);
          const markerKind = sourceConfig?.markerKind ?? 'site';

          return {
            type: 'Feature',
            id: place.id,
            geometry: { type: 'Point', coordinates: [place.lon, place.lat] },
            properties: {
              name: place.name,
              point_type: pointType,
              marker_color: markerColor,
              marker_stroke: markerStroke,
              marker_kind: markerKind,
              icon_id:
                pointType === 'airport'
                  ? createAirportIconId(markerColor, markerStroke)
                  : pointType === 'site'
                    ? markerKind === 'festival'
                      ? createFestivalIconId(markerColor, markerStroke)
                      : createSiteIconId(markerColor, markerStroke)
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
        .filter((feature) => (feature as any).properties?.marker_kind !== 'festival')
        .map((feature) => ({
          fill: String((feature as any).properties.marker_color),
          stroke: String((feature as any).properties.marker_stroke),
        }));
      const festivalIcons = pointFeatures
        .filter(
          (feature): feature is (typeof pointFeatures)[number] & {
            properties: { point_type: string; marker_color: string; marker_stroke: string };
          } =>
            Boolean(feature) &&
            (feature as any).properties?.point_type === 'site' &&
            (feature as any).properties?.marker_kind === 'festival',
        )
        .map((feature) => ({
          fill: String((feature as any).properties.marker_color),
          stroke: String((feature as any).properties.marker_stroke),
        }));
      ensureAirportIcons(map, airportIcons);
      ensureSiteIcons(map, siteIcons);
      ensureFestivalIcons(map, festivalIcons);
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
      setUiError('Some profile data could not be drawn on the map.');
    }
  }, [activeTrips, activeVisits, defaultVisuals, getSiteSourceConfig, isMapReady, isMultiProfileView, pointLookup, profileId, profileVisualsById, themeMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    map.setLayoutProperty('trip-routes-line', 'visibility', showTripRoutes ? 'visible' : 'none');
  }, [isMapReady, showTripRoutes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    const source = map.getSource('osm') as maplibregl.RasterTileSource | undefined;
    source?.setTiles(basemapTilesByLabelLanguage[mapLabelLanguage]);
  }, [isMapReady, mapLabelLanguage]);

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

  const focusOnPlace = async (place: Place) => {
    const map = mapRef.current;
    if (!map) return;

    try {
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
    } catch {
      setUiError('Could not load map details for that place.');
    }

    setSelectedMapPlaceId(place.id);
    if (place.lat !== undefined && place.lon !== undefined) {
      map.flyTo({ center: [place.lon, place.lat], zoom: 5, duration: 800 });
    }
  };

  useImperativeHandle(ref, () => ({ focusOnPlace }));

  return <div ref={mapContainerRef} className={`map ${mainView === 'map' ? '' : 'map-hidden'}`} />;
});
