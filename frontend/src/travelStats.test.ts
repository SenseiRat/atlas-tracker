import { describe, expect, it } from 'vitest';
import {
  buildTravelDataContext,
  classifyTripByCountry,
  type TravelPlace,
  type TravelPlacesByType,
  type TravelTripLog,
  type TravelVisit,
} from './travelStats';

function emptyPlaces(): TravelPlacesByType {
  return { country: [], state: [], city: [], airport: [], site: [] };
}

const AIRPORTS: Record<string, TravelPlace> = {
  'airport-us1': { id: 'airport-us1', name: 'JFK', country_code: 'USA', lat: 40.6, lon: -73.8, airport_code: 'JFK' },
  'airport-us2': { id: 'airport-us2', name: 'LAX', country_code: 'USA', lat: 33.9, lon: -118.4, airport_code: 'LAX' },
  'airport-gb1': { id: 'airport-gb1', name: 'LHR', country_code: 'GBR', lat: 51.5, lon: -0.5, airport_code: 'LHR' },
};

function placesWithAirports(): TravelPlacesByType {
  const places = emptyPlaces();
  places.airport = Object.values(AIRPORTS);
  return places;
}

function trip(overrides: Partial<TravelTripLog> & Pick<TravelTripLog, 'id' | 'origin_place_id' | 'destination_place_id'>): TravelTripLog {
  const routeIds = [overrides.origin_place_id, ...(overrides.layover_place_ids ?? []), overrides.destination_place_id];
  return {
    profile_id: 1,
    flown_on: '2026-03-10',
    layover_place_ids: [],
    estimated_miles: 100,
    created_at: '2026-03-10T00:00:00',
    route_points: routeIds.map((pid) => {
      const p = AIRPORTS[pid];
      return { id: pid, name: p?.name ?? pid, lat: p?.lat ?? 0, lon: p?.lon ?? 0, country_code: p?.country_code };
    }),
    segments: [],
    ...overrides,
  };
}

describe('classifyTripByCountry', () => {
  const placesById = new Map(Object.values(AIRPORTS).map((p) => [p.id, p] as const));

  it('detects domestic trips (same country)', () => {
    expect(classifyTripByCountry({ origin_place_id: 'airport-us1', destination_place_id: 'airport-us2' }, placesById)).toBe('domestic');
  });

  it('detects international trips (different country)', () => {
    expect(classifyTripByCountry({ origin_place_id: 'airport-us1', destination_place_id: 'airport-gb1' }, placesById)).toBe('international');
  });

  it('returns unknown when a country code is missing', () => {
    expect(classifyTripByCountry({ origin_place_id: 'airport-missing', destination_place_id: 'airport-gb1' }, placesById)).toBe('unknown');
  });
});

describe('buildTravelDataContext', () => {
  it('classifies trips even when the origin is not a catalog route point', () => {
    // route_points intentionally empty -> old code (routeAirportPlaces.find) would miss the origin
    const t = trip({ id: 1, origin_place_id: 'airport-us1', destination_place_id: 'airport-gb1' });
    t.route_points = [];
    const ctx = buildTravelDataContext({ places: placesWithAirports(), visits: [], tripLogs: [t] });
    expect(classifyTripByCountry(t, ctx.placesById)).toBe('international');
  });

  it('uses an injected clock for current year/month (UTC)', () => {
    const now = new Date('2026-03-15T12:00:00Z');
    const ctx = buildTravelDataContext({ places: emptyPlaces(), visits: [], tripLogs: [], now });
    expect(ctx.currentYear).toBe(2026);
    expect(ctx.currentMonth).toBe(3);
  });

  it('defaults the clock to the real now when none is injected', () => {
    const ctx = buildTravelDataContext({ places: emptyPlaces(), visits: [], tripLogs: [] });
    expect(ctx.currentYear).toBe(new Date().getUTCFullYear());
  });

  it('counts unique trip date keys distinctly from trip count', () => {
    const visits: TravelVisit[] = [];
    const sameDay1 = trip({ id: 1, origin_place_id: 'airport-us1', destination_place_id: 'airport-us2', flown_on: '2026-01-01' });
    const sameDay2 = trip({ id: 2, origin_place_id: 'airport-us2', destination_place_id: 'airport-us1', flown_on: '2026-01-01' });
    const ctx = buildTravelDataContext({ places: placesWithAirports(), visits, tripLogs: [sameDay1, sameDay2] });
    // two trips on the same calendar day
    expect(ctx.datedTrips.length).toBe(2);
    expect(ctx.uniqueTripDateKeys.length).toBe(1);
  });
});
