import {
  buildTravelDataContext,
  classifyTripByCountry,
  type TravelDataContext,
  type TravelPlace,
  type TravelPlacesByType,
  type TravelTripLog,
  type TravelVisit,
} from './travelStats';

type AchievementCategoryId = 'trips' | 'geography' | 'flights_transit' | 'exploration' | 'collections' | 'milestones';
type AchievementStatus = 'locked' | 'in_progress' | 'unlocked';
type AchievementValueFormat = 'count' | 'distance_miles' | 'elevation_meters' | 'hours';
type AchievementMetricKey =
  | 'trip_count'
  | 'years_with_travel'
  | 'max_trips_in_year'
  | 'max_new_places_in_year'
  | 'countries_visited'
  | 'continents_visited'
  | 'states_visited'
  | 'cities_visited'
  | 'flights_taken'
  | 'airports_visited'
  | 'border_crossings'
  | 'layovers_completed'
  | 'total_distance'
  | 'farthest_trip_from_home'
  | 'longest_single_leg'
  | 'timezones_visited'
  | 'largest_timezone_jump'
  | 'highest_elevation'
  | 'capitals_visited'
  | 'unesco_sites_visited'
  | 'world_wonders_visited'
  | 'michelin_sites_visited';
type AchievementMilestoneKey =
  | 'first_trip'
  | 'first_international_trip'
  | 'first_domestic_trip'
  | 'first_flight'
  | 'first_border_crossing'
  | 'north_south_hemispheres'
  | 'east_west_hemispheres'
  | 'all_four_hemispheres'
  | 'equator_crossing'
  | 'prime_meridian_crossing'
  | 'international_date_line_crossing'
  | 'first_unesco_site'
  | 'first_world_wonder'
  | 'first_michelin_site'
  | 'first_capital_city';
type AchievementCapabilityKey = 'states_catalog' | 'capital_catalog' | 'unesco_catalog' | 'world_wonders_catalog' | 'michelin_catalog';

type AchievementUnit = {
  singular: string;
  plural: string;
  compact?: string;
};

type AchievementBaseDefinition = {
  id: string;
  name: string;
  description: string;
  category: AchievementCategoryId;
  sortOrder: number;
  iconKey?: string;
  hiddenUntilUnlocked?: boolean;
  capabilities?: AchievementCapabilityKey[];
};

type TieredAchievementDefinition = AchievementBaseDefinition & {
  type: 'tiered';
  metric: AchievementMetricKey;
  thresholds: number[];
  valueFormat?: AchievementValueFormat;
  unit?: AchievementUnit;
};

type MilestoneAchievementDefinition = AchievementBaseDefinition & {
  type: 'milestone';
  condition: AchievementMilestoneKey;
};

type AchievementDefinition = TieredAchievementDefinition | MilestoneAchievementDefinition;

type ExtendedAchievementContext = {
  data: TravelDataContext;
  places: TravelPlacesByType;
  tripLogs: TravelTripLog[];
  placesById: Map<string, TravelPlace>;
  availableSiteCategories: Set<string>;
};

export type AchievementTierHistoryItem = {
  threshold: number;
  label: string;
};

type AchievementBaseItem = {
  id: string;
  name: string;
  description: string;
  category: AchievementCategoryId;
  sortOrder: number;
  iconKey?: string;
};

export type TieredAchievementItem = AchievementBaseItem & {
  type: 'tiered';
  status: AchievementStatus;
  currentValue: number;
  currentValueLabel: string;
  currentTierLabel: string | null;
  nextTierLabel: string | null;
  progressPercent: number;
  progressLabel: string;
  unlockedTierHistory: AchievementTierHistoryItem[];
  unlockedBadgeCount: number;
  totalBadgeCount: number;
};

export type MilestoneAchievementItem = AchievementBaseItem & {
  type: 'milestone';
  status: 'locked' | 'unlocked';
  unlocked: boolean;
  unlockedBadgeCount: number;
  totalBadgeCount: number;
};

export type AchievementItem = TieredAchievementItem | MilestoneAchievementItem;

export type AchievementSection = {
  id: AchievementCategoryId;
  label: string;
  items: AchievementItem[];
  unlockedBadges: number;
  totalBadges: number;
};

export type AchievementModel = {
  summary: {
    unlockedBadges: number;
    totalBadges: number;
    completedAchievements: number;
    totalAchievements: number;
    inProgressAchievements: number;
  };
  sections: AchievementSection[];
};

const CATEGORY_LABELS: Record<AchievementCategoryId, string> = {
  trips: 'Trips',
  geography: 'Geography',
  flights_transit: 'Flights & Transit',
  exploration: 'Exploration',
  collections: 'Collections',
  milestones: 'Milestones',
};

const COUNT_UNIT: AchievementUnit = { singular: 'place', plural: 'places' };
const TRIP_UNIT: AchievementUnit = { singular: 'trip', plural: 'trips' };
const YEAR_UNIT: AchievementUnit = { singular: 'year', plural: 'years' };
const COUNTRY_UNIT: AchievementUnit = { singular: 'country', plural: 'countries' };
const CONTINENT_UNIT: AchievementUnit = { singular: 'continent', plural: 'continents' };
const REGION_UNIT: AchievementUnit = { singular: 'region', plural: 'regions' };
const CITY_UNIT: AchievementUnit = { singular: 'city', plural: 'cities' };
const FLIGHT_UNIT: AchievementUnit = { singular: 'flight', plural: 'flights' };
const AIRPORT_UNIT: AchievementUnit = { singular: 'airport', plural: 'airports' };
const CROSSING_UNIT: AchievementUnit = { singular: 'crossing', plural: 'crossings' };
const LAYOVER_UNIT: AchievementUnit = { singular: 'layover', plural: 'layovers' };
const DISTANCE_UNIT: AchievementUnit = { singular: 'mile', plural: 'miles', compact: 'mi' };
const TIMEZONE_UNIT: AchievementUnit = { singular: 'time zone', plural: 'time zones' };
const HOUR_UNIT: AchievementUnit = { singular: 'hour', plural: 'hours', compact: 'hr' };
const ELEVATION_UNIT: AchievementUnit = { singular: 'meter', plural: 'meters', compact: 'm' };
const CAPITAL_UNIT: AchievementUnit = { singular: 'capital', plural: 'capitals' };
const SITE_UNIT: AchievementUnit = { singular: 'site', plural: 'sites' };
const WONDER_UNIT: AchievementUnit = { singular: 'wonder', plural: 'wonders' };
const RESTAURANT_UNIT: AchievementUnit = { singular: 'restaurant', plural: 'restaurants' };

const TOTAL_DISTANCE_THRESHOLDS_MILES = [100, 1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000].map(
  (kilometers) => Math.round(kilometers * 0.621371),
);

const ACHIEVEMENT_REGISTRY: AchievementDefinition[] = [
  { id: 'trips_recorded', name: 'First Steps', description: 'Record more trips over time.', category: 'trips', type: 'tiered', metric: 'trip_count', thresholds: [1, 3, 5, 10, 25, 50, 100], valueFormat: 'count', unit: TRIP_UNIT, iconKey: 'trips', sortOrder: 1 },
  { id: 'years_with_travel', name: 'Travel Years', description: 'Log travel in more calendar years.', category: 'trips', type: 'tiered', metric: 'years_with_travel', thresholds: [1, 3, 5, 10, 20], valueFormat: 'count', unit: YEAR_UNIT, iconKey: 'calendar', sortOrder: 2 },
  { id: 'trips_single_year', name: 'Packed Calendar', description: 'Hit new highs for trips in a single year.', category: 'trips', type: 'tiered', metric: 'max_trips_in_year', thresholds: [3, 5, 10, 20, 50], valueFormat: 'count', unit: TRIP_UNIT, iconKey: 'calendar-stack', sortOrder: 3 },
  { id: 'new_places_single_year', name: 'Discovery Run', description: 'Set a record for new places first visited in one year.', category: 'trips', type: 'tiered', metric: 'max_new_places_in_year', thresholds: [3, 5, 10, 25, 50], valueFormat: 'count', unit: COUNT_UNIT, iconKey: 'discovery', sortOrder: 4 },
  { id: 'countries_visited', name: 'Country Counter', description: 'Reach more unique countries.', category: 'geography', type: 'tiered', metric: 'countries_visited', thresholds: [1, 3, 5, 10, 20, 30, 50, 75, 100], valueFormat: 'count', unit: COUNTRY_UNIT, iconKey: 'country', sortOrder: 10 },
  { id: 'continents_visited', name: 'Continental', description: 'Reach more continents.', category: 'geography', type: 'tiered', metric: 'continents_visited', thresholds: [1, 2, 3, 4, 5, 6, 7], valueFormat: 'count', unit: CONTINENT_UNIT, iconKey: 'continent', sortOrder: 11 },
  { id: 'states_visited', name: 'Region Runner', description: 'Track first-level regions across the map.', category: 'geography', type: 'tiered', metric: 'states_visited', thresholds: [1, 5, 10, 25, 50, 100, 200], valueFormat: 'count', unit: REGION_UNIT, capabilities: ['states_catalog'], iconKey: 'region', sortOrder: 12 },
  { id: 'cities_visited', name: 'City Collector', description: 'Reach more unique cities.', category: 'geography', type: 'tiered', metric: 'cities_visited', thresholds: [1, 5, 10, 25, 50, 100, 200, 500], valueFormat: 'count', unit: CITY_UNIT, iconKey: 'city', sortOrder: 13 },
  { id: 'flights_taken', name: 'Frequent Flyer', description: 'Log more flight legs.', category: 'flights_transit', type: 'tiered', metric: 'flights_taken', thresholds: [1, 5, 10, 25, 50, 100, 250], valueFormat: 'count', unit: FLIGHT_UNIT, iconKey: 'flight', sortOrder: 20 },
  { id: 'airports_visited', name: 'Airport Hopper', description: 'Touch down at more unique airports.', category: 'flights_transit', type: 'tiered', metric: 'airports_visited', thresholds: [1, 5, 10, 25, 50, 100, 200], valueFormat: 'count', unit: AIRPORT_UNIT, iconKey: 'airport', sortOrder: 21 },
  { id: 'border_crossings', name: 'Border Hopper', description: 'Cross more national borders in logged flight routes.', category: 'flights_transit', type: 'tiered', metric: 'border_crossings', thresholds: [1, 5, 10, 25, 50, 100], valueFormat: 'count', unit: CROSSING_UNIT, iconKey: 'border', sortOrder: 22 },
  { id: 'layovers_completed', name: 'Layover Loop', description: 'Chain together more layover stops.', category: 'flights_transit', type: 'tiered', metric: 'layovers_completed', thresholds: [1, 5, 10, 25, 50], valueFormat: 'count', unit: LAYOVER_UNIT, iconKey: 'layover', sortOrder: 23 },
  { id: 'total_distance_traveled', name: 'Miles Ahead', description: 'Stack up more total flight distance.', category: 'exploration', type: 'tiered', metric: 'total_distance', thresholds: TOTAL_DISTANCE_THRESHOLDS_MILES, valueFormat: 'distance_miles', unit: DISTANCE_UNIT, iconKey: 'distance', sortOrder: 30 },
  { id: 'farthest_trip_from_home', name: 'Far From Home', description: 'Push your farthest trip farther from your usual origin.', category: 'exploration', type: 'tiered', metric: 'farthest_trip_from_home', thresholds: [100, 500, 1000, 5000, 10000, 15000], valueFormat: 'distance_miles', unit: DISTANCE_UNIT, iconKey: 'home-distance', sortOrder: 31 },
  { id: 'longest_single_leg', name: 'Long Haul', description: 'Set new single-leg distance records.', category: 'exploration', type: 'tiered', metric: 'longest_single_leg', thresholds: [500, 1000, 2500, 5000, 10000], valueFormat: 'distance_miles', unit: DISTANCE_UNIT, iconKey: 'route', sortOrder: 32 },
  { id: 'timezones_visited', name: 'Time Shifter', description: 'Reach more time zones.', category: 'exploration', type: 'tiered', metric: 'timezones_visited', thresholds: [1, 3, 5, 10, 15, 20, 24], valueFormat: 'count', unit: TIMEZONE_UNIT, iconKey: 'timezone', sortOrder: 33 },
  { id: 'largest_timezone_jump', name: 'Jet Lag', description: 'Make bigger time-zone jumps in a single trip.', category: 'exploration', type: 'tiered', metric: 'largest_timezone_jump', thresholds: [3, 6, 9, 12], valueFormat: 'hours', unit: HOUR_UNIT, iconKey: 'clock-shift', sortOrder: 34 },
  { id: 'highest_elevation_reached', name: 'High Point', description: 'Climb to higher elevations.', category: 'exploration', type: 'tiered', metric: 'highest_elevation', thresholds: [500, 1000, 2000, 3000, 4000, 5000, 6000], valueFormat: 'elevation_meters', unit: ELEVATION_UNIT, iconKey: 'elevation', sortOrder: 35 },
  { id: 'capitals_visited', name: 'Capital Collector', description: 'Visit more capital cities.', category: 'collections', type: 'tiered', metric: 'capitals_visited', thresholds: [1, 3, 5, 10, 20, 50], valueFormat: 'count', unit: CAPITAL_UNIT, capabilities: ['capital_catalog'], iconKey: 'capital', sortOrder: 40 },
  { id: 'unesco_sites_visited', name: 'Heritage Hunter', description: 'Visit more UNESCO sites from the tracked lists.', category: 'collections', type: 'tiered', metric: 'unesco_sites_visited', thresholds: [1, 3, 5, 10, 25, 50, 100], valueFormat: 'count', unit: SITE_UNIT, capabilities: ['unesco_catalog'], iconKey: 'unesco', sortOrder: 41 },
  { id: 'world_wonders_visited', name: 'Wonder Seeker', description: 'Collect visits to tracked world wonders.', category: 'collections', type: 'tiered', metric: 'world_wonders_visited', thresholds: [1, 3, 5, 7], valueFormat: 'count', unit: WONDER_UNIT, capabilities: ['world_wonders_catalog'], iconKey: 'wonder', sortOrder: 42 },
  { id: 'michelin_restaurants_visited', name: 'Star Table', description: 'Visit more Michelin-starred restaurants.', category: 'collections', type: 'tiered', metric: 'michelin_sites_visited', thresholds: [1, 3, 5, 10, 25, 50], valueFormat: 'count', unit: RESTAURANT_UNIT, capabilities: ['michelin_catalog'], iconKey: 'michelin', sortOrder: 43 },
  { id: 'milestone_first_trip', name: 'First Trip', description: 'Log your first recorded trip.', category: 'milestones', type: 'milestone', condition: 'first_trip', iconKey: 'trip', sortOrder: 50 },
  { id: 'milestone_first_international_trip', name: 'First Abroad', description: 'Take your first international trip.', category: 'milestones', type: 'milestone', condition: 'first_international_trip', iconKey: 'passport', sortOrder: 51 },
  { id: 'milestone_first_domestic_trip', name: 'First Domestic', description: 'Take your first domestic trip.', category: 'milestones', type: 'milestone', condition: 'first_domestic_trip', iconKey: 'home', sortOrder: 52 },
  { id: 'milestone_first_flight', name: 'Wheels Up', description: 'Log your first flight.', category: 'milestones', type: 'milestone', condition: 'first_flight', iconKey: 'plane', sortOrder: 53 },
  { id: 'milestone_first_border_crossing', name: 'First Crossing', description: 'Record your first border crossing.', category: 'milestones', type: 'milestone', condition: 'first_border_crossing', iconKey: 'border', sortOrder: 54 },
  { id: 'milestone_north_south', name: 'North & South', description: 'Visit both the northern and southern hemispheres.', category: 'milestones', type: 'milestone', condition: 'north_south_hemispheres', iconKey: 'hemisphere-ns', sortOrder: 55 },
  { id: 'milestone_east_west', name: 'East & West', description: 'Visit both the eastern and western hemispheres.', category: 'milestones', type: 'milestone', condition: 'east_west_hemispheres', iconKey: 'hemisphere-ew', sortOrder: 56 },
  { id: 'milestone_all_four_hemispheres', name: 'Four Corners', description: 'Visit all four hemispheres.', category: 'milestones', type: 'milestone', condition: 'all_four_hemispheres', iconKey: 'hemisphere-all', sortOrder: 57 },
  { id: 'milestone_equator_crossing', name: 'Equator Crossed', description: 'Cross the Equator on a logged trip.', category: 'milestones', type: 'milestone', condition: 'equator_crossing', iconKey: 'equator', sortOrder: 58 },
  { id: 'milestone_prime_meridian_crossing', name: 'Prime Meridian', description: 'Cross the Prime Meridian on a logged trip.', category: 'milestones', type: 'milestone', condition: 'prime_meridian_crossing', iconKey: 'meridian', sortOrder: 59 },
  { id: 'milestone_date_line_crossing', name: 'Date Line', description: 'Cross the International Date Line on a logged trip.', category: 'milestones', type: 'milestone', condition: 'international_date_line_crossing', iconKey: 'date-line', sortOrder: 60 },
  { id: 'milestone_first_unesco_site', name: 'First Heritage', description: 'Visit your first UNESCO site.', category: 'milestones', type: 'milestone', condition: 'first_unesco_site', capabilities: ['unesco_catalog'], iconKey: 'unesco', sortOrder: 61 },
  { id: 'milestone_first_world_wonder', name: 'First Wonder', description: 'Visit your first tracked world wonder.', category: 'milestones', type: 'milestone', condition: 'first_world_wonder', capabilities: ['world_wonders_catalog'], iconKey: 'wonder', sortOrder: 62 },
  { id: 'milestone_first_michelin', name: 'First Star', description: 'Visit your first Michelin-starred restaurant.', category: 'milestones', type: 'milestone', condition: 'first_michelin_site', capabilities: ['michelin_catalog'], iconKey: 'michelin', sortOrder: 63 },
  { id: 'milestone_first_capital_city', name: 'Capital Arrival', description: 'Visit your first capital city.', category: 'milestones', type: 'milestone', condition: 'first_capital_city', capabilities: ['capital_catalog'], iconKey: 'capital', sortOrder: 64 },
];

const capabilityResolvers: Record<AchievementCapabilityKey, (context: ExtendedAchievementContext) => boolean> = {
  states_catalog: (context) => context.places.state.length > 0,
  capital_catalog: (context) =>
    context.places.city.some((place) => place.feature_code === 'PPLC') ||
    context.data.destinationPlaces.some((place) => place.feature_code === 'PPLC'),
  unesco_catalog: (context) => context.availableSiteCategories.has('heritage_unesco'),
  world_wonders_catalog: (context) => Array.from(context.availableSiteCategories).some(isWonderCategory),
  michelin_catalog: (context) => context.availableSiteCategories.has('michelin_starred'),
};

const metricResolvers: Record<AchievementMetricKey, (context: ExtendedAchievementContext) => number | null> = {
  trip_count: (context) => context.data.datedTrips.length,
  years_with_travel: (context) => context.data.tripYears.size,
  max_trips_in_year: (context) => maxMapValue(context.data.tripYears),
  max_new_places_in_year: (context) => {
    const countsByYear = new Map<number, number>();
    context.data.destinationFirstSeenByPlaceId.forEach((dateKey) => {
      const year = Number.parseInt(dateKey.slice(0, 4), 10);
      if (!Number.isNaN(year)) countsByYear.set(year, (countsByYear.get(year) ?? 0) + 1);
    });
    return maxMapValue(countsByYear);
  },
  countries_visited: (context) => context.data.allCountryCodes.size,
  continents_visited: (context) => context.data.continentsVisited.size,
  states_visited: (context) => context.data.statesVisited.size,
  cities_visited: (context) => context.data.destinationCityLabels.size,
  flights_taken: (context) => context.data.totalFlightLegs,
  airports_visited: (context) => context.data.airportsVisited,
  border_crossings: (context) => context.data.borderCrossingsByAir,
  layovers_completed: (context) => context.tripLogs.reduce((sum, trip) => sum + (Array.isArray(trip.layover_place_ids) ? trip.layover_place_ids.length : 0), 0),
  total_distance: (context) => context.data.totalDistanceMiles,
  farthest_trip_from_home: (context) => context.data.farthestTripFromHome?.miles ?? 0,
  longest_single_leg: (context) => context.data.longSingleLeg?.miles ?? 0,
  timezones_visited: (context) => context.data.timezonesVisited.size,
  largest_timezone_jump: (context) => context.data.largestTimezoneJump?.hours ?? 0,
  highest_elevation: (context) => context.data.highestElevation?.value ?? 0,
  capitals_visited: (context) => context.data.capitalCitiesVisited,
  unesco_sites_visited: (context) => countPlacesByCategory(context.data.destinationPlaces, (category) => category === 'heritage_unesco'),
  world_wonders_visited: (context) => countPlacesByCategory(context.data.destinationPlaces, isWonderCategory),
  michelin_sites_visited: (context) => countPlacesByCategory(context.data.destinationPlaces, (category) => category === 'michelin_starred'),
};

const milestoneResolvers: Record<AchievementMilestoneKey, (context: ExtendedAchievementContext) => { unlocked: boolean }> = {
  first_trip: (context) => ({ unlocked: context.data.datedTrips.length > 0 }),
  first_international_trip: (context) => ({ unlocked: context.data.datedTrips.some((trip) => isInternationalTrip(trip, context)) }),
  first_domestic_trip: (context) => ({ unlocked: context.data.datedTrips.some((trip) => isDomesticTrip(trip, context)) }),
  first_flight: (context) => ({ unlocked: context.data.totalFlightLegs > 0 }),
  first_border_crossing: (context) => ({ unlocked: context.data.borderCrossingsByAir > 0 }),
  north_south_hemispheres: (context) => ({ unlocked: context.data.destinationPlaces.some((place) => typeof place.lat === 'number' && place.lat > 0) && context.data.destinationPlaces.some((place) => typeof place.lat === 'number' && place.lat < 0) }),
  east_west_hemispheres: (context) => ({ unlocked: context.data.destinationPlaces.some((place) => typeof place.lon === 'number' && place.lon > 0) && context.data.destinationPlaces.some((place) => typeof place.lon === 'number' && place.lon < 0) }),
  all_four_hemispheres: (context) => ({ unlocked: hasAllFourQuadrants(context.data.destinationPlaces) }),
  equator_crossing: (context) => ({ unlocked: context.data.datedTrips.some((trip) => tripCrossesBoundary(trip, context, 'lat')) }),
  prime_meridian_crossing: (context) => ({ unlocked: context.data.datedTrips.some((trip) => tripCrossesBoundary(trip, context, 'lon')) }),
  international_date_line_crossing: (context) => ({ unlocked: context.data.datedTrips.some((trip) => tripCrossesDateLine(trip, context)) }),
  first_unesco_site: (context) => ({ unlocked: countPlacesByCategory(context.data.destinationPlaces, (category) => category === 'heritage_unesco') > 0 }),
  first_world_wonder: (context) => ({ unlocked: countPlacesByCategory(context.data.destinationPlaces, isWonderCategory) > 0 }),
  first_michelin_site: (context) => ({ unlocked: countPlacesByCategory(context.data.destinationPlaces, (category) => category === 'michelin_starred') > 0 }),
  first_capital_city: (context) => ({ unlocked: context.data.capitalCitiesVisited > 0 }),
};

function maxMapValue(map: Map<number, number>) {
  return map.size > 0 ? Math.max(...Array.from(map.values())) : 0;
}

function isWonderCategory(category?: string | null) {
  return String(category || '').trim().toLowerCase().startsWith('wonder_');
}

function countPlacesByCategory(places: TravelPlace[], matcher: (category?: string | null) => boolean) {
  return places.reduce((count, place) => (matcher(place.category) ? count + 1 : count), 0);
}

function formatNumber(value: number, format: AchievementValueFormat) {
  if (format === 'hours' && value % 1 !== 0) return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return Math.round(value).toLocaleString();
}

function formatValue(value: number, format: AchievementValueFormat, unit?: AchievementUnit) {
  const numberLabel = formatNumber(value, format);
  if (!unit) return numberLabel;
  const unitLabel = value === 1 ? unit.singular : unit.plural;
  if (format === 'distance_miles' || format === 'elevation_meters' || format === 'hours') {
    return `${numberLabel} ${unit.compact ?? unitLabel}`;
  }
  return `${numberLabel} ${unitLabel}`;
}

function buildPlacesById(places: TravelPlacesByType) {
  const placesById = new Map<string, TravelPlace>();
  (Object.values(places) as TravelPlace[][]).forEach((entries) => {
    entries.forEach((place) => placesById.set(place.id, place));
  });
  return placesById;
}

function hasAllFourQuadrants(places: TravelPlace[]) {
  const quadrants = new Set<string>();
  places.forEach((place) => {
    if (typeof place.lat !== 'number' || typeof place.lon !== 'number' || place.lat === 0 || place.lon === 0) return;
    quadrants.add(`${place.lat > 0 ? 'n' : 's'}${place.lon > 0 ? 'e' : 'w'}`);
  });
  return ['ne', 'nw', 'se', 'sw'].every((key) => quadrants.has(key));
}

function getTripRoutePlaces(trip: TravelDataContext['datedTrips'][number], context: ExtendedAchievementContext) {
  const fromRoutePoints = Array.isArray(trip.route_points)
    ? trip.route_points.map((point) => context.placesById.get(point.id)).filter((place): place is TravelPlace => Boolean(place))
    : [];
  if (fromRoutePoints.length >= 2) return fromRoutePoints;

  return [trip.origin_place_id, ...(Array.isArray(trip.layover_place_ids) ? trip.layover_place_ids : []), trip.destination_place_id]
    .map((placeId) => context.placesById.get(placeId))
    .filter((place): place is TravelPlace => Boolean(place));
}

function isDomesticTrip(trip: TravelDataContext['datedTrips'][number], context: ExtendedAchievementContext) {
  return classifyTripByCountry(trip, context.placesById) === 'domestic';
}

function isInternationalTrip(trip: TravelDataContext['datedTrips'][number], context: ExtendedAchievementContext) {
  return classifyTripByCountry(trip, context.placesById) === 'international';
}

function tripCrossesBoundary(trip: TravelDataContext['datedTrips'][number], context: ExtendedAchievementContext, axis: 'lat' | 'lon') {
  const routePlaces = getTripRoutePlaces(trip, context);
  for (let index = 1; index < routePlaces.length; index += 1) {
    const previous = routePlaces[index - 1][axis];
    const current = routePlaces[index][axis];
    if (typeof previous !== 'number' || typeof current !== 'number') continue;
    if ((previous < 0 && current > 0) || (previous > 0 && current < 0)) return true;
  }
  return false;
}

function tripCrossesDateLine(trip: TravelDataContext['datedTrips'][number], context: ExtendedAchievementContext) {
  const routePlaces = getTripRoutePlaces(trip, context);
  for (let index = 1; index < routePlaces.length; index += 1) {
    const previous = routePlaces[index - 1].lon;
    const current = routePlaces[index].lon;
    if (typeof previous !== 'number' || typeof current !== 'number') continue;
    if (Math.abs(previous - current) > 180) return true;
  }
  return false;
}

function isDefinitionSupported(definition: AchievementDefinition, context: ExtendedAchievementContext) {
  return (definition.capabilities ?? []).every((key) => capabilityResolvers[key](context));
}

function evaluateTieredAchievement(definition: TieredAchievementDefinition, context: ExtendedAchievementContext): TieredAchievementItem | null {
  const currentValue = Math.max(metricResolvers[definition.metric](context) ?? 0, 0);
  const unlockedThresholds = definition.thresholds.filter((threshold) => currentValue >= threshold);
  if (definition.hiddenUntilUnlocked && unlockedThresholds.length === 0) return null;

  const valueFormat = definition.valueFormat ?? 'count';
  const nextTier = definition.thresholds[unlockedThresholds.length] ?? null;
  const progressPercent = nextTier === null ? 100 : Math.max(0, Math.min(100, (currentValue / Math.max(nextTier, 1)) * 100));

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    type: 'tiered',
    status: unlockedThresholds.length === definition.thresholds.length ? 'unlocked' : currentValue > 0 ? 'in_progress' : 'locked',
    sortOrder: definition.sortOrder,
    iconKey: definition.iconKey,
    currentValue,
    currentValueLabel: formatValue(currentValue, valueFormat, definition.unit),
    currentTierLabel: unlockedThresholds.length > 0 ? formatValue(unlockedThresholds[unlockedThresholds.length - 1], valueFormat, definition.unit) : null,
    nextTierLabel: nextTier === null ? null : formatValue(nextTier, valueFormat, definition.unit),
    progressPercent,
    progressLabel: nextTier === null ? 'All tiers unlocked' : `${formatValue(currentValue, valueFormat, definition.unit)} / ${formatValue(nextTier, valueFormat, definition.unit)}`,
    unlockedTierHistory: unlockedThresholds.map((threshold) => ({ threshold, label: formatValue(threshold, valueFormat, definition.unit) })),
    unlockedBadgeCount: unlockedThresholds.length,
    totalBadgeCount: definition.thresholds.length,
  };
}

function evaluateMilestoneAchievement(definition: MilestoneAchievementDefinition, context: ExtendedAchievementContext): MilestoneAchievementItem | null {
  const unlocked = milestoneResolvers[definition.condition](context).unlocked;
  if (definition.hiddenUntilUnlocked && !unlocked) return null;

  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    type: 'milestone',
    status: unlocked ? 'unlocked' : 'locked',
    unlocked,
    sortOrder: definition.sortOrder,
    iconKey: definition.iconKey,
    unlockedBadgeCount: unlocked ? 1 : 0,
    totalBadgeCount: 1,
  };
}

export function buildAchievementModel(args: { places: TravelPlacesByType; visits: TravelVisit[]; tripLogs: TravelTripLog[] }): AchievementModel {
  const context: ExtendedAchievementContext = {
    data: buildTravelDataContext(args),
    places: args.places,
    tripLogs: args.tripLogs,
    placesById: buildPlacesById(args.places),
    availableSiteCategories: new Set(args.places.site.map((place) => String(place.category || '').trim().toLowerCase()).filter((category) => Boolean(category))),
  };

  const items = ACHIEVEMENT_REGISTRY
    .filter((definition) => isDefinitionSupported(definition, context))
    .map((definition) => (definition.type === 'tiered' ? evaluateTieredAchievement(definition, context) : evaluateMilestoneAchievement(definition, context)))
    .filter((item): item is AchievementItem => Boolean(item));

  const sections = (Object.keys(CATEGORY_LABELS) as AchievementCategoryId[])
    .map((category) => {
      const sectionItems = items
        .filter((item) => item.category === category)
        .sort((first, second) => first.sortOrder - second.sortOrder || first.name.localeCompare(second.name));
      return {
        id: category,
        label: CATEGORY_LABELS[category],
        items: sectionItems,
        unlockedBadges: sectionItems.reduce((sum, item) => sum + item.unlockedBadgeCount, 0),
        totalBadges: sectionItems.reduce((sum, item) => sum + item.totalBadgeCount, 0),
      };
    })
    .filter((section) => section.items.length > 0);

  return {
    summary: {
      unlockedBadges: sections.reduce((sum, section) => sum + section.unlockedBadges, 0),
      totalBadges: sections.reduce((sum, section) => sum + section.totalBadges, 0),
      completedAchievements: items.filter((item) => (item.type === 'milestone' ? item.unlocked : item.status === 'unlocked')).length,
      totalAchievements: items.length,
      inProgressAchievements: items.filter((item) => item.type === 'tiered' && item.status === 'in_progress').length,
    },
    sections,
  };
}
