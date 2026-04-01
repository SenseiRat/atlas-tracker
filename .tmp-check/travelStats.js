const CURRENT_YEAR = new Date().getFullYear();
const CURRENT_MONTH = new Date().getMonth() + 1;
const KG_CO2E_PER_MILE = 0.24;
const SECTION_LABELS = {
    trips: 'Trips',
    distance_transit: 'Distance and Transit',
    time: 'Time',
    geography: 'Geography',
    passport_borders_logistics: 'Passport / Borders / Logistics',
    michelin: 'Michelin',
    achievements_gamified: 'Achievements / Gamified',
};
const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function normalizeCode(value) {
    return String(value || '').trim().toUpperCase();
}
function normalizeName(value) {
    return String(value || '').trim().toLowerCase();
}
function parseDateKey(value) {
    const raw = String(value || '').trim();
    if (!raw)
        return null;
    const key = raw.slice(0, 10);
    const date = new Date(`${key}T12:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : { key, date };
}
function formatCount(value) {
    return value.toLocaleString();
}
function formatMiles(value) {
    return `${Math.round(value).toLocaleString()} mi`;
}
function formatDays(value) {
    return `${value.toLocaleString()} day${value === 1 ? '' : 's'}`;
}
function formatPercent(value) {
    return `${value.toFixed(1)}%`;
}
function formatDate(value) {
    const parsed = parseDateKey(value);
    if (!parsed)
        return value;
    return parsed.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatMonth(month) {
    return MONTH_LABELS[month - 1] ?? `Month ${month}`;
}
function getSeason(month) {
    if (month === 12 || month <= 2)
        return 'Winter';
    if (month <= 5)
        return 'Spring';
    if (month <= 8)
        return 'Summer';
    return 'Autumn';
}
function placeTypeFromId(placeId) {
    if (placeId.startsWith('country-'))
        return 'country';
    if (placeId.startsWith('state-'))
        return 'state';
    if (placeId.startsWith('city-'))
        return 'city';
    if (placeId.startsWith('airport-'))
        return 'airport';
    if (placeId.startsWith('site-'))
        return 'site';
    return null;
}
function milesBetween(lat1, lon1, lat2, lon2) {
    const radiusMiles = 3958.8;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return radiusMiles * c;
}
function differenceInDays(first, second) {
    const msPerDay = 24 * 60 * 60 * 1000;
    return Math.round(Math.abs(second.getTime() - first.getTime()) / msPerDay);
}
function createSentence(label, displayValue, detail) {
    return detail ? `${label}: ${displayValue}. ${detail}` : `${label}: ${displayValue}.`;
}
function incrementCounter(map, key, amount = 1) {
    map.set(key, (map.get(key) ?? 0) + amount);
}
function makeCountResult(label, value, detail) {
    const displayValue = formatCount(value);
    return { displayValue, detail, sentence: createSentence(label, displayValue, detail) };
}
function makeMilesResult(label, value, detail) {
    const displayValue = formatMiles(value);
    return { displayValue, detail, sentence: createSentence(label, displayValue, detail) };
}
function makeDaysResult(label, value, detail) {
    const displayValue = formatDays(value);
    return { displayValue, detail, sentence: createSentence(label, displayValue, detail) };
}
function makePercentResult(label, value, detail) {
    const displayValue = formatPercent(value);
    return { displayValue, detail, sentence: createSentence(label, displayValue, detail) };
}
function buildTimezoneResolver(places) {
    const lookup = new Map();
    places.city.forEach((city) => {
        if (!city.timezone || !city.country_code)
            return;
        lookup.set(`${normalizeName(city.name)}|${normalizeCode(city.state_code)}|${normalizeCode(city.country_code)}`, city.timezone);
        lookup.set(`${normalizeName(city.name)}||${normalizeCode(city.country_code)}`, city.timezone);
    });
    return (place) => {
        if (place.timezone)
            return place.timezone;
        if (!place.municipality || !place.country_code)
            return null;
        return (lookup.get(`${normalizeName(place.municipality)}|${normalizeCode(place.state_code)}|${normalizeCode(place.country_code)}`) ??
            lookup.get(`${normalizeName(place.municipality)}||${normalizeCode(place.country_code)}`) ??
            null);
    };
}
function getTimeZoneOffsetMinutes(timeZone, date) {
    try {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            timeZoneName: 'shortOffset',
            hour: '2-digit',
        });
        const token = formatter.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value || '';
        const match = token.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
        if (!match)
            return null;
        const sign = match[1] === '-' ? -1 : 1;
        const hours = Number.parseInt(match[2], 10);
        const minutes = Number.parseInt(match[3] || '0', 10);
        return sign * (hours * 60 + minutes);
    }
    catch {
        return null;
    }
}
function buildContext(places, visits, tripLogs) {
    const placesById = new Map();
    Object.values(places).forEach((items) => {
        items.forEach((place) => placesById.set(place.id, place));
    });
    const resolveTimezone = buildTimezoneResolver(places);
    const countryNameByCode = new Map();
    places.country.forEach((country) => {
        if (country.country_code)
            countryNameByCode.set(normalizeCode(country.country_code), country.name);
    });
    const visitedPlaces = visits.map((visit) => placesById.get(visit.place_id)).filter((place) => Boolean(place));
    const destinationPlaces = Array.from(new Map([...visitedPlaces, ...tripLogs.map((trip) => placesById.get(trip.destination_place_id)).filter((place) => Boolean(place))].map((place) => [place.id, place])).values());
    const routeAirportPlaces = Array.from(new Map(tripLogs
        .flatMap((trip) => trip.route_points.map((point) => placesById.get(point.id)).filter((place) => Boolean(place)))
        .map((place) => [place.id, place])).values());
    const datedTrips = tripLogs
        .map((trip) => {
        const parsed = parseDateKey(trip.flown_on || trip.created_at);
        if (!parsed)
            return null;
        return { ...trip, dateKey: parsed.key, date: parsed.date };
    })
        .filter((trip) => Boolean(trip))
        .sort((a, b) => a.date.getTime() - b.date.getTime());
    const uniqueTripDateKeys = Array.from(new Set(datedTrips.map((trip) => trip.dateKey))).sort();
    const tripMonths = new Map();
    const tripYears = new Map();
    const tripSeasons = new Map();
    const travelDaysByYear = new Map();
    datedTrips.forEach((trip) => {
        const month = trip.date.getUTCMonth() + 1;
        const year = trip.date.getUTCFullYear();
        incrementCounter(tripMonths, month);
        incrementCounter(tripYears, year);
        incrementCounter(tripSeasons, getSeason(month));
    });
    uniqueTripDateKeys.forEach((key) => {
        const parsed = parseDateKey(key);
        if (!parsed)
            return;
        incrementCounter(travelDaysByYear, parsed.date.getUTCFullYear());
    });
    const destinationCounts = new Map();
    const destinationFirstSeenByPlaceId = new Map();
    datedTrips.forEach((trip) => {
        incrementCounter(destinationCounts, trip.destination_place_id);
        const existing = destinationFirstSeenByPlaceId.get(trip.destination_place_id);
        if (!existing || trip.dateKey < existing)
            destinationFirstSeenByPlaceId.set(trip.destination_place_id, trip.dateKey);
    });
    visits.forEach((visit) => {
        const parsed = parseDateKey(visit.visited_at);
        if (!parsed)
            return;
        const existing = destinationFirstSeenByPlaceId.get(visit.place_id);
        if (!existing || parsed.key < existing)
            destinationFirstSeenByPlaceId.set(visit.place_id, parsed.key);
    });
    const allCountryCodes = new Set();
    const destinationCityLabels = new Set();
    const countryCounts = new Map();
    const cityCounts = new Map();
    const incrementPlaceCounter = (map, key, label) => {
        const current = map.get(key);
        if (current) {
            current.count += 1;
            return;
        }
        map.set(key, { label, count: 1 });
    };
    destinationPlaces.forEach((place) => {
        const countryCode = normalizeCode(place.country_code);
        if (countryCode) {
            allCountryCodes.add(countryCode);
            incrementPlaceCounter(countryCounts, countryCode, countryNameByCode.get(countryCode) ?? place.country_code ?? place.name);
        }
        (place.country_codes ?? []).forEach((code) => allCountryCodes.add(normalizeCode(code)));
        const cityLabel = placeTypeFromId(place.id) === 'city'
            ? place.name
            : placeTypeFromId(place.id) === 'airport'
                ? place.municipality || place.name
                : '';
        if (cityLabel) {
            destinationCityLabels.add(cityLabel);
            incrementPlaceCounter(cityCounts, `${countryCode}:${normalizeName(cityLabel)}`, cityLabel);
        }
    });
    datedTrips.forEach((trip) => {
        const destinationPlace = placesById.get(trip.destination_place_id);
        if (!destinationPlace)
            return;
        const countryCode = normalizeCode(destinationPlace.country_code);
        if (countryCode) {
            allCountryCodes.add(countryCode);
            incrementPlaceCounter(countryCounts, countryCode, countryNameByCode.get(countryCode) ?? destinationPlace.country_code ?? destinationPlace.name);
        }
        const cityLabel = placeTypeFromId(destinationPlace.id) === 'city'
            ? destinationPlace.name
            : placeTypeFromId(destinationPlace.id) === 'airport'
                ? destinationPlace.municipality || destinationPlace.name
                : '';
        if (cityLabel) {
            destinationCityLabels.add(cityLabel);
            incrementPlaceCounter(cityCounts, `${countryCode}:${normalizeName(cityLabel)}`, cityLabel);
        }
    });
    const homeAirportCounts = new Map();
    tripLogs.forEach((trip) => incrementCounter(homeAirportCounts, trip.origin_place_id));
    const rankedHomeAirports = Array.from(homeAirportCounts.entries()).sort((a, b) => b[1] - a[1]);
    const homeAirport = rankedHomeAirports.length > 0 ? placesById.get(rankedHomeAirports[0][0]) ?? null : null;
    const homeAirportTripCount = rankedHomeAirports[0]?.[1] ?? 0;
    let farthestDestinationFromHome = null;
    let closestDestinationToHome = null;
    let farthestTripFromHome = null;
    if (homeAirport?.lat !== undefined && homeAirport.lon !== undefined) {
        destinationPlaces.forEach((place) => {
            if (place.id === homeAirport.id || place.lat === undefined || place.lon === undefined)
                return;
            const miles = milesBetween(homeAirport.lat, homeAirport.lon, place.lat, place.lon);
            if (!farthestDestinationFromHome || miles > farthestDestinationFromHome.miles)
                farthestDestinationFromHome = { place, miles };
            if (!closestDestinationToHome || miles < closestDestinationToHome.miles)
                closestDestinationToHome = { place, miles };
        });
        datedTrips.forEach((trip) => {
            const place = placesById.get(trip.destination_place_id);
            if (!place || place.lat === undefined || place.lon === undefined)
                return;
            const miles = milesBetween(homeAirport.lat, homeAirport.lon, place.lat, place.lon);
            if (!farthestTripFromHome || miles > farthestTripFromHome.miles) {
                farthestTripFromHome = { trip, miles, place };
            }
        });
    }
    let longSingleLeg = null;
    let totalFlightLegs = 0;
    let totalDistanceMiles = 0;
    let totalDistanceMilesThisYear = 0;
    let totalGreatCircleMiles = 0;
    let borderCrossingsByAir = 0;
    let maxCountriesInTrip = null;
    let largestTimezoneJump = null;
    const timezonesVisited = new Set();
    routeAirportPlaces.forEach((place) => {
        const timezone = resolveTimezone(place);
        if (timezone)
            timezonesVisited.add(timezone);
    });
    destinationPlaces.forEach((place) => {
        const timezone = place.timezone || resolveTimezone(place);
        if (timezone)
            timezonesVisited.add(timezone);
    });
    datedTrips.forEach((trip) => {
        totalFlightLegs += Math.max(1, trip.segments.length || 1);
        totalDistanceMiles += trip.estimated_miles;
        totalGreatCircleMiles += trip.segments.reduce((sum, segment) => sum + (segment.miles || 0), 0);
        if (trip.date.getUTCFullYear() === CURRENT_YEAR)
            totalDistanceMilesThisYear += trip.estimated_miles;
        const tripCountryCodes = new Set();
        const offsets = [];
        trip.route_points.forEach((point) => {
            const place = placesById.get(point.id);
            const countryCode = normalizeCode(place?.country_code || point.country_code);
            if (countryCode)
                tripCountryCodes.add(countryCode);
            const timezone = place ? place.timezone || resolveTimezone(place) : null;
            if (timezone) {
                timezonesVisited.add(timezone);
                const offset = getTimeZoneOffsetMinutes(timezone, trip.date);
                if (offset !== null)
                    offsets.push(offset);
            }
        });
        if (tripCountryCodes.size > (maxCountriesInTrip?.count ?? 0)) {
            maxCountriesInTrip = { count: tripCountryCodes.size, detail: trip.route_points.map((point) => point.name).join(' -> ') };
        }
        if (offsets.length > 1) {
            const jumpHours = (Math.max(...offsets) - Math.min(...offsets)) / 60;
            if (jumpHours > (largestTimezoneJump?.hours ?? 0)) {
                largestTimezoneJump = { hours: jumpHours, detail: trip.route_points.map((point) => point.name).join(' -> ') };
            }
        }
        trip.segments.forEach((segment) => {
            if (segment.miles > (longSingleLeg?.miles ?? 0)) {
                longSingleLeg = { segmentLabel: `${segment.from_name} -> ${segment.to_name}`, miles: segment.miles };
            }
            const fromPlace = placesById.get(segment.from_place_id);
            const toPlace = placesById.get(segment.to_place_id);
            if (fromPlace?.country_code &&
                toPlace?.country_code &&
                normalizeCode(fromPlace.country_code) !== normalizeCode(toPlace.country_code)) {
                borderCrossingsByAir += 1;
            }
        });
    });
    const regionsVisited = new Set();
    const statesVisited = new Set();
    const continentsVisited = new Set();
    let capitalCitiesVisited = 0;
    let unescoVisited = 0;
    let michelinVisited = 0;
    const michelinCountries = new Set();
    let northernmost = null;
    let southernmost = null;
    let easternmost = null;
    let westernmost = null;
    let highestElevation = null;
    let lowestElevation = null;
    const latitudes = [];
    const longitudes = [];
    const hemisphereParts = new Set();
    destinationPlaces.forEach((place) => {
        const countryCode = normalizeCode(place.country_code);
        const stateCode = normalizeCode(place.state_code);
        if (countryCode && stateCode) {
            const regionKey = `${countryCode}:${stateCode}`;
            regionsVisited.add(regionKey);
            statesVisited.add(regionKey);
        }
        if (countryCode) {
            const continent = places.country.find((country) => normalizeCode(country.country_code) === countryCode)?.continent;
            if (continent)
                continentsVisited.add(continent);
        }
        if (place.feature_code === 'PPLC')
            capitalCitiesVisited += 1;
        if (place.category === 'heritage_unesco')
            unescoVisited += 1;
        if (place.category === 'michelin_starred') {
            michelinVisited += 1;
            if (countryCode)
                michelinCountries.add(countryCode);
        }
        if (place.lat !== undefined) {
            latitudes.push(place.lat);
            if (!northernmost || place.lat > northernmost.value)
                northernmost = { name: place.name, value: place.lat };
            if (!southernmost || place.lat < southernmost.value)
                southernmost = { name: place.name, value: place.lat };
            hemisphereParts.add(place.lat >= 0 ? 'Northern' : 'Southern');
        }
        if (place.lon !== undefined) {
            longitudes.push(place.lon);
            if (!easternmost || place.lon > easternmost.value)
                easternmost = { name: place.name, value: place.lon };
            if (!westernmost || place.lon < westernmost.value)
                westernmost = { name: place.name, value: place.lon };
            hemisphereParts.add(place.lon >= 0 ? 'Eastern' : 'Western');
        }
        if (typeof place.elevation_m === 'number') {
            if (!highestElevation || place.elevation_m > highestElevation.value)
                highestElevation = { name: place.name, value: place.elevation_m };
            if (!lowestElevation || place.elevation_m < lowestElevation.value)
                lowestElevation = { name: place.name, value: place.elevation_m };
        }
    });
    const totalLatitudeRange = latitudes.length >= 2 ? Math.max(...latitudes) - Math.min(...latitudes) : latitudes.length === 1 ? 0 : null;
    const totalLongitudeRange = longitudes.length >= 2 ? Math.max(...longitudes) - Math.min(...longitudes) : longitudes.length === 1 ? 0 : null;
    const hemisphereCoverage = hemisphereParts.size > 0 ? Array.from(hemisphereParts).join(' + ') : 'Unavailable';
    const repeatDestinationGroups = Array.from(destinationCounts.values()).filter((count) => count > 1).length;
    const uniqueDestinationGroups = destinationCounts.size;
    const repeatDestinationPercent = uniqueDestinationGroups ? (repeatDestinationGroups / uniqueDestinationGroups) * 100 : null;
    const newDestinationPercent = uniqueDestinationGroups ? ((uniqueDestinationGroups - repeatDestinationGroups) / uniqueDestinationGroups) * 100 : null;
    const newPlacesThisYear = destinationFirstSeenByPlaceId.size
        ? Array.from(destinationFirstSeenByPlaceId.values()).filter((dateKey) => dateKey.startsWith(`${CURRENT_YEAR}-`)).length
        : null;
    const countryRevisitCounts = new Map();
    datedTrips.forEach((trip) => {
        const destinationPlace = placesById.get(trip.destination_place_id);
        const countryCode = normalizeCode(destinationPlace?.country_code);
        if (!countryCode)
            return;
        incrementCounter(countryRevisitCounts, countryCode);
    });
    const countriesRevisitedAfterFirstVisit = countryRevisitCounts.size
        ? Array.from(countryRevisitCounts.values()).filter((count) => count > 1).length
        : null;
    const michelinVisitDates = visits
        .filter((visit) => placesById.get(visit.place_id)?.category === 'michelin_starred')
        .map((visit) => parseDateKey(visit.visited_at)?.key ?? null)
        .filter((value) => Boolean(value))
        .sort();
    return {
        visitedPlaces,
        destinationPlaces,
        routeAirportPlaces,
        datedTrips,
        uniqueTripDateKeys,
        tripMonths,
        tripYears,
        tripSeasons,
        travelDaysByYear,
        allCountryCodes,
        destinationCityLabels,
        destinationCounts,
        destinationFirstSeenByPlaceId,
        countryCounts,
        cityCounts,
        homeAirport,
        homeAirportTripCount,
        farthestDestinationFromHome,
        closestDestinationToHome,
        farthestTripFromHome,
        longSingleLeg,
        maxCountriesInTrip,
        borderCrossingsByAir,
        airportsVisited: routeAirportPlaces.length,
        totalFlightLegs,
        totalDistanceMiles,
        totalDistanceMilesThisYear,
        totalGreatCircleMiles: totalGreatCircleMiles || totalDistanceMiles,
        repeatDestinationPercent,
        newDestinationPercent,
        newPlacesThisYear,
        continentsVisited,
        regionsVisited,
        statesVisited,
        timezonesVisited,
        largestTimezoneJump,
        uniquePlacesPinned: destinationPlaces.length,
        northernmost,
        southernmost,
        easternmost,
        westernmost,
        highestElevation,
        lowestElevation,
        totalLatitudeRange,
        totalLongitudeRange,
        hemisphereCoverage,
        unescoVisited,
        michelinVisited,
        michelinCountries,
        capitalCitiesVisited,
        countriesRevisitedAfterFirstVisit,
        firstMichelinVisitDate: michelinVisitDates[0] ?? null,
        latestMichelinVisitDate: michelinVisitDates[michelinVisitDates.length - 1] ?? null,
    };
}
const calculators = {
    total_trips: (context) => makeCountResult('Total trips taken', context.datedTrips.length),
    total_countries: (context) => makeCountResult('Total countries visited', context.allCountryCodes.size),
    total_cities: (context) => makeCountResult('Total cities visited', context.destinationCityLabels.size),
    total_destinations: (context) => makeCountResult('Total destinations visited', context.destinationPlaces.length),
    total_days_traveled: (context) => makeDaysResult('Total days traveled', context.uniqueTripDateKeys.length),
    most_visited_country: (context) => {
        const top = Array.from(context.countryCounts.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0];
        if (!top)
            return null;
        return {
            displayValue: top.label,
            detail: `${formatCount(top.count)} tracked arrivals and visits`,
            sentence: `${top.label} is your most visited country, with ${formatCount(top.count)} tracked arrivals and visits.`,
        };
    },
    most_visited_city: (context) => {
        const top = Array.from(context.cityCounts.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0];
        if (!top)
            return null;
        return {
            displayValue: top.label,
            detail: `${formatCount(top.count)} tracked arrivals`,
            sentence: `${top.label} is your most visited city, with ${formatCount(top.count)} tracked arrivals.`,
        };
    },
    farthest_trip_from_home: (context) => !context.farthestTripFromHome || !context.homeAirport
        ? null
        : {
            displayValue: formatMiles(context.farthestTripFromHome.miles),
            detail: `${context.homeAirport.name} -> ${context.farthestTripFromHome.place.name}`,
            sentence: `Your farthest trip from home spans ${formatMiles(context.farthestTripFromHome.miles)} from ${context.homeAirport.name} to ${context.farthestTripFromHome.place.name}.`,
        },
    domestic_trips: (context) => makeCountResult('Number of domestic trips', context.datedTrips.filter((trip) => {
        const origin = context.routeAirportPlaces.find((place) => place.id === trip.origin_place_id);
        const destination = context.destinationPlaces.find((place) => place.id === trip.destination_place_id);
        return Boolean(origin?.country_code && destination?.country_code && normalizeCode(origin.country_code) === normalizeCode(destination.country_code));
    }).length),
    international_trips: (context) => makeCountResult('Number of international trips', context.datedTrips.filter((trip) => {
        const origin = context.routeAirportPlaces.find((place) => place.id === trip.origin_place_id);
        const destination = context.destinationPlaces.find((place) => place.id === trip.destination_place_id);
        return Boolean(origin?.country_code && destination?.country_code && normalizeCode(origin.country_code) !== normalizeCode(destination.country_code));
    }).length),
    total_distance: (context) => makeMilesResult('Total distance traveled', context.totalDistanceMiles),
    flights_taken: (context) => makeCountResult('Number of flights taken', context.totalFlightLegs),
    continents_visited: (context) => makeCountResult('Continents visited', context.continentsVisited.size),
    favorite_travel_month: (context) => {
        const top = Array.from(context.tripMonths.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
        if (!top)
            return null;
        return {
            displayValue: formatMonth(top[0]),
            detail: `${formatCount(top[1])} trips logged`,
            sentence: `${formatMonth(top[0])} is your favorite travel month so far, with ${formatCount(top[1])} trips logged.`,
        };
    },
    most_traveled_year: (context) => {
        const top = Array.from(context.tripYears.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
        if (!top)
            return null;
        return {
            displayValue: String(top[0]),
            detail: `${formatCount(top[1])} trips`,
            sentence: `${top[0]} is your most traveled year, with ${formatCount(top[1])} trips recorded.`,
        };
    },
    new_places_this_year: (context) => context.newPlacesThisYear === null
        ? null
        : { displayValue: formatCount(context.newPlacesThisYear), detail: `first seen in ${CURRENT_YEAR}`, sentence: `${formatCount(context.newPlacesThisYear)} places appear for the first time in ${CURRENT_YEAR}.` },
    largest_timezone_jump: (context) => !context.largestTimezoneJump
        ? null
        : { displayValue: `${context.largestTimezoneJump.hours.toFixed(1)} hours`, detail: context.largestTimezoneJump.detail, sentence: `Your largest time zone jump in one trip is ${context.largestTimezoneJump.hours.toFixed(1)} hours on ${context.largestTimezoneJump.detail}.` },
    unesco_sites_visited: (context) => makeCountResult('UNESCO sites visited', context.unescoVisited),
    michelin_sites_visited: (context) => makeCountResult('Michelin-starred restaurants visited', context.michelinVisited),
    farthest_destination_from_home: (context) => !context.farthestDestinationFromHome || !context.homeAirport
        ? null
        : { displayValue: context.farthestDestinationFromHome.place.name, detail: `${formatMiles(context.farthestDestinationFromHome.miles)} from ${context.homeAirport.name}`, sentence: `${context.farthestDestinationFromHome.place.name} is your farthest destination from home at ${formatMiles(context.farthestDestinationFromHome.miles)} from ${context.homeAirport.name}.` },
    repeat_destinations_percentage: (context) => (context.repeatDestinationPercent === null ? null : makePercentResult('Percentage of repeat destinations', context.repeatDestinationPercent)),
    new_destinations_percentage: (context) => (context.newDestinationPercent === null ? null : makePercentResult('Percentage of new destinations', context.newDestinationPercent)),
    distance_this_year: (context) => makeMilesResult('Distance traveled this year', context.totalDistanceMilesThisYear),
    average_distance_per_trip: (context) => (context.datedTrips.length === 0 ? null : makeMilesResult('Average distance per trip', context.totalDistanceMiles / context.datedTrips.length)),
    longest_single_leg: (context) => !context.longSingleLeg
        ? null
        : { displayValue: formatMiles(context.longSingleLeg.miles), detail: context.longSingleLeg.segmentLabel, sentence: `Your longest single leg is ${formatMiles(context.longSingleLeg.miles)} on ${context.longSingleLeg.segmentLabel}.` },
    countries_crossed_in_one_trip: (context) => !context.maxCountriesInTrip
        ? null
        : { displayValue: formatCount(context.maxCountriesInTrip.count), detail: context.maxCountriesInTrip.detail, sentence: `Your widest single trip crossed ${formatCount(context.maxCountriesInTrip.count)} countries on ${context.maxCountriesInTrip.detail}.` },
    border_crossings: (context) => makeCountResult('Number of border crossings', context.borderCrossingsByAir),
    airports_visited: (context) => makeCountResult('Number of airports visited', context.airportsVisited),
    travel_days_in_transit: (context) => makeDaysResult('Number of total travel days in transit', context.uniqueTripDateKeys.length),
    great_circle_distance: (context) => makeMilesResult('Great-circle distance traveled', context.totalGreatCircleMiles),
    estimated_co2: (context) => ({ displayValue: `${Math.round(context.totalDistanceMiles * KG_CO2E_PER_MILE).toLocaleString()} kg CO2e`, detail: 'using a fixed per-mile flight estimate', sentence: `Estimated flight emissions total ${Math.round(context.totalDistanceMiles * KG_CO2E_PER_MILE).toLocaleString()} kg CO2e using a fixed per-mile estimate.` }),
    trips_this_year: (context) => makeCountResult('Trips this year', context.datedTrips.filter((trip) => trip.date.getUTCFullYear() === CURRENT_YEAR).length),
    trips_this_month: (context) => makeCountResult('Trips this month', context.datedTrips.filter((trip) => trip.date.getUTCFullYear() === CURRENT_YEAR && trip.date.getUTCMonth() + 1 === CURRENT_MONTH).length),
    days_traveled_this_year: (context) => makeDaysResult('Days traveled this year', context.travelDaysByYear.get(CURRENT_YEAR) ?? 0),
    years_with_trip: (context) => makeCountResult('Years with at least one trip', context.tripYears.size),
    current_travel_streak_by_year: (context) => {
        if (context.tripYears.size === 0)
            return null;
        const years = new Set(context.tripYears.keys());
        let streak = years.has(CURRENT_YEAR) ? 1 : 0;
        let cursor = CURRENT_YEAR - 1;
        while (streak > 0 && years.has(cursor)) {
            streak += 1;
            cursor -= 1;
        }
        return makeCountResult('Current travel streak by year', streak);
    },
    longest_gap_between_trips: (context) => {
        if (context.datedTrips.length < 2)
            return null;
        let gap = 0;
        for (let index = 1; index < context.datedTrips.length; index += 1)
            gap = Math.max(gap, differenceInDays(context.datedTrips[index - 1].date, context.datedTrips[index].date));
        return makeDaysResult('Longest gap between trips', gap);
    },
    shortest_gap_between_trips: (context) => {
        if (context.datedTrips.length < 2)
            return null;
        let gap = Number.POSITIVE_INFINITY;
        for (let index = 1; index < context.datedTrips.length; index += 1)
            gap = Math.min(gap, differenceInDays(context.datedTrips[index - 1].date, context.datedTrips[index].date));
        return makeDaysResult('Shortest gap between trips', gap);
    },
    most_traveled_month: (context) => calculators.favorite_travel_month(context),
    least_traveled_month: (context) => {
        const entries = Array.from(context.tripMonths.entries()).filter(([, count]) => count > 0);
        const lowest = entries.sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
        if (!lowest)
            return null;
        return { displayValue: formatMonth(lowest[0]), detail: `${formatCount(lowest[1])} trips logged`, sentence: `${formatMonth(lowest[0])} is your least traveled month, with ${formatCount(lowest[1])} trips logged.` };
    },
    average_trips_per_year: (context) => (context.tripYears.size === 0 ? null : makeCountResult('Average trips per year', Math.round(context.datedTrips.length / context.tripYears.size))),
    average_travel_days_per_year: (context) => (context.travelDaysByYear.size === 0 ? null : makeDaysResult('Average travel days per year', Math.round(context.uniqueTripDateKeys.length / context.travelDaysByYear.size))),
    trips_by_season: (context) => {
        if (context.tripSeasons.size === 0)
            return null;
        const detail = ['Winter', 'Spring', 'Summer', 'Autumn'].map((season) => `${season} ${formatCount(context.tripSeasons.get(season) ?? 0)}`).join(' | ');
        return { displayValue: detail, sentence: `Trips by season: ${detail}.` };
    },
    regions_visited: (context) => makeCountResult('Regions visited', context.regionsVisited.size),
    states_visited: (context) => makeCountResult('States / provinces / territories visited', context.statesVisited.size),
    capitals_visited: (context) => makeCountResult('Capitals visited', context.capitalCitiesVisited),
    unique_places_pinned: (context) => makeCountResult('Number of unique places pinned on map', context.uniquePlacesPinned),
    northernmost_point: (context) => (!context.northernmost ? null : { displayValue: context.northernmost.name, detail: `${context.northernmost.value.toFixed(2)}° latitude`, sentence: `${context.northernmost.name} is your northernmost point at ${context.northernmost.value.toFixed(2)}° latitude.` }),
    southernmost_point: (context) => (!context.southernmost ? null : { displayValue: context.southernmost.name, detail: `${context.southernmost.value.toFixed(2)}° latitude`, sentence: `${context.southernmost.name} is your southernmost point at ${context.southernmost.value.toFixed(2)}° latitude.` }),
    easternmost_point: (context) => (!context.easternmost ? null : { displayValue: context.easternmost.name, detail: `${context.easternmost.value.toFixed(2)}° longitude`, sentence: `${context.easternmost.name} is your easternmost point at ${context.easternmost.value.toFixed(2)}° longitude.` }),
    westernmost_point: (context) => (!context.westernmost ? null : { displayValue: context.westernmost.name, detail: `${context.westernmost.value.toFixed(2)}° longitude`, sentence: `${context.westernmost.name} is your westernmost point at ${context.westernmost.value.toFixed(2)}° longitude.` }),
    highest_elevation: (context) => (!context.highestElevation ? null : { displayValue: context.highestElevation.name, detail: `${Math.round(context.highestElevation.value).toLocaleString()} m`, sentence: `${context.highestElevation.name} is your highest elevation reached at ${Math.round(context.highestElevation.value).toLocaleString()} m.` }),
    lowest_elevation: (context) => (!context.lowestElevation ? null : { displayValue: context.lowestElevation.name, detail: `${Math.round(context.lowestElevation.value).toLocaleString()} m`, sentence: `${context.lowestElevation.name} is your lowest elevation visited at ${Math.round(context.lowestElevation.value).toLocaleString()} m.` }),
    closest_destination_to_home: (context) => (!context.closestDestinationToHome || !context.homeAirport ? null : { displayValue: context.closestDestinationToHome.place.name, detail: `${formatMiles(context.closestDestinationToHome.miles)} from ${context.homeAirport.name}`, sentence: `${context.closestDestinationToHome.place.name} is your closest destination to home at ${formatMiles(context.closestDestinationToHome.miles)} from ${context.homeAirport.name}.` }),
    timezones_visited: (context) => makeCountResult('Number of time zones visited', context.timezonesVisited.size),
    total_latitude_range: (context) => (context.totalLatitudeRange === null ? null : { displayValue: `${context.totalLatitudeRange.toFixed(2)}°`, sentence: `Your total latitude range covered is ${context.totalLatitudeRange.toFixed(2)}°.` }),
    total_longitude_range: (context) => (context.totalLongitudeRange === null ? null : { displayValue: `${context.totalLongitudeRange.toFixed(2)}°`, sentence: `Your total longitude range covered is ${context.totalLongitudeRange.toFixed(2)}°.` }),
    hemisphere_coverage: (context) => ({ displayValue: context.hemisphereCoverage, sentence: `Hemisphere coverage: ${context.hemisphereCoverage}.` }),
    border_crossings_by_air: (context) => makeCountResult('Border crossings by air', context.borderCrossingsByAir),
    countries_revisited_after_first_visit: (context) => (context.countriesRevisitedAfterFirstVisit === null ? null : makeCountResult('Countries revisited after first visit', context.countriesRevisitedAfterFirstVisit)),
    michelin_countries: (context) => makeCountResult('Countries with Michelin-starred restaurant visits', context.michelinCountries.size),
    first_michelin_visit_date: (context) => (context.firstMichelinVisitDate ? { displayValue: formatDate(context.firstMichelinVisitDate), sentence: `Your first Michelin-starred restaurant visit on record was ${formatDate(context.firstMichelinVisitDate)}.` } : null),
    latest_michelin_visit_date: (context) => (context.latestMichelinVisitDate ? { displayValue: formatDate(context.latestMichelinVisitDate), sentence: `Your latest Michelin-starred restaurant visit on record was ${formatDate(context.latestMichelinVisitDate)}.` } : null),
    unsupported: () => null,
};
const supportedDefinitions = [
    { id: 'hero_total_trips', label: 'Total trips taken', section: 'trips', priority: 1, description: 'Count of logged trips.', selector: 'total_trips', visibilityTier: 'hero' },
    { id: 'hero_total_countries', label: 'Total countries visited', section: 'trips', priority: 2, description: 'Distinct destination countries and explicit country visits.', selector: 'total_countries', visibilityTier: 'hero' },
    { id: 'hero_total_cities', label: 'Total cities visited', section: 'trips', priority: 3, description: 'Distinct cities from tracked destinations.', selector: 'total_cities', visibilityTier: 'hero' },
    { id: 'hero_total_destinations', label: 'Total destinations visited', section: 'trips', priority: 4, description: 'Distinct tracked destination places.', selector: 'total_destinations', visibilityTier: 'hero' },
    { id: 'hero_total_days', label: 'Total days traveled', section: 'time', priority: 5, description: 'Distinct calendar days with a logged trip.', selector: 'total_days_traveled', visibilityTier: 'hero' },
    { id: 'hero_most_country', label: 'Most visited country', section: 'trips', priority: 6, description: 'Country with the most tracked arrivals and visits.', selector: 'most_visited_country', visibilityTier: 'hero' },
    { id: 'hero_most_city', label: 'Most visited city', section: 'trips', priority: 7, description: 'City with the most tracked arrivals.', selector: 'most_visited_city', visibilityTier: 'hero' },
    { id: 'hero_farthest_trip', label: 'Farthest trip from home', section: 'trips', priority: 8, description: 'Farthest destination from the inferred home airport.', selector: 'farthest_trip_from_home', visibilityTier: 'hero' },
    { id: 'hero_domestic', label: 'Number of domestic trips', section: 'trips', priority: 9, description: 'Trips whose origin and destination share a country.', selector: 'domestic_trips', visibilityTier: 'hero' },
    { id: 'hero_international', label: 'Number of international trips', section: 'trips', priority: 10, description: 'Trips whose origin and destination cross a country border.', selector: 'international_trips', visibilityTier: 'hero' },
    { id: 'hero_distance', label: 'Total distance traveled', section: 'distance_transit', priority: 11, description: 'Estimated total flight mileage from logged trips.', selector: 'total_distance', visibilityTier: 'hero' },
    { id: 'hero_flights', label: 'Number of flights taken', section: 'distance_transit', priority: 12, description: 'Flight legs across all logged trips.', selector: 'flights_taken', visibilityTier: 'hero' },
    { id: 'hero_continents', label: 'Continents visited', section: 'geography', priority: 13, description: 'Distinct continents reached by tracked destinations.', selector: 'continents_visited', visibilityTier: 'hero' },
    { id: 'highlight_favorite_month', label: 'Favorite travel month', section: 'time', priority: 1, description: 'Month with the most logged trips.', selector: 'favorite_travel_month', visibilityTier: 'highlight' },
    { id: 'highlight_most_year', label: 'Most traveled year', section: 'time', priority: 2, description: 'Year with the most logged trips.', selector: 'most_traveled_year', visibilityTier: 'highlight' },
    { id: 'highlight_new_places', label: 'New places visited this year', section: 'time', priority: 3, description: 'Destinations first seen this calendar year.', selector: 'new_places_this_year', visibilityTier: 'highlight' },
    { id: 'highlight_timezone_jump', label: 'Largest time zone jump in one trip', section: 'distance_transit', priority: 4, description: 'Largest resolved time zone span in a single itinerary.', selector: 'largest_timezone_jump', visibilityTier: 'highlight' },
    { id: 'highlight_unesco', label: 'UNESCO sites visited', section: 'geography', priority: 5, description: 'Visited UNESCO-tagged sites.', selector: 'unesco_sites_visited', visibilityTier: 'highlight' },
    { id: 'highlight_michelin', label: 'Michelin-starred restaurants visited', section: 'michelin', priority: 6, description: 'Visited Michelin-starred restaurants.', selector: 'michelin_sites_visited', visibilityTier: 'highlight' },
    { id: 'highlight_country', label: 'Most visited country', section: 'trips', priority: 7, description: 'Country with the most tracked arrivals and visits.', selector: 'most_visited_country', visibilityTier: 'highlight' },
    { id: 'highlight_city', label: 'Most visited city', section: 'trips', priority: 8, description: 'City with the most tracked arrivals.', selector: 'most_visited_city', visibilityTier: 'highlight' },
    { id: 'highlight_farthest_destination', label: 'Farthest destination from home', section: 'geography', priority: 9, description: 'Most distant destination from the inferred home airport.', selector: 'farthest_destination_from_home', visibilityTier: 'highlight' },
    { id: 'highlight_repeat_percentage', label: 'Percentage of repeat destinations', section: 'trips', priority: 10, description: 'Share of unique destinations visited more than once.', selector: 'repeat_destinations_percentage', visibilityTier: 'highlight' },
    { id: 'highlight_new_percentage', label: 'Percentage of new destinations', section: 'trips', priority: 11, description: 'Share of unique destinations seen only once.', selector: 'new_destinations_percentage', visibilityTier: 'highlight' },
];
const expandableDefinitions = [
    ['trips_total_trips', 'Total trips taken', 'trips', 1, 'total_trips'],
    ['trips_total_countries', 'Total countries visited', 'trips', 2, 'total_countries'],
    ['trips_total_cities', 'Total cities visited', 'trips', 3, 'total_cities'],
    ['trips_total_destinations', 'Total destinations visited', 'trips', 4, 'total_destinations'],
    ['trips_total_days', 'Total days traveled', 'trips', 5, 'total_days_traveled'],
    ['trips_most_country', 'Most visited country', 'trips', 6, 'most_visited_country'],
    ['trips_most_city', 'Most visited city', 'trips', 7, 'most_visited_city'],
    ['trips_farthest_trip', 'Farthest trip from home', 'trips', 8, 'farthest_trip_from_home'],
    ['trips_domestic', 'Number of domestic trips', 'trips', 9, 'domestic_trips'],
    ['trips_international', 'Number of international trips', 'trips', 10, 'international_trips'],
    ['distance_total', 'Total distance traveled', 'distance_transit', 1, 'total_distance'],
    ['distance_year', 'Distance traveled this year', 'distance_transit', 2, 'distance_this_year'],
    ['distance_avg', 'Average distance per trip', 'distance_transit', 3, 'average_distance_per_trip'],
    ['distance_leg', 'Longest single-leg journey', 'distance_transit', 4, 'longest_single_leg'],
    ['distance_flights', 'Number of flights taken', 'distance_transit', 5, 'flights_taken'],
    ['distance_countries', 'Number of countries crossed in one trip', 'distance_transit', 6, 'countries_crossed_in_one_trip'],
    ['distance_borders', 'Number of border crossings', 'distance_transit', 7, 'border_crossings'],
    ['distance_airports', 'Number of airports visited', 'distance_transit', 8, 'airports_visited'],
    ['distance_days', 'Number of total travel days in transit', 'distance_transit', 9, 'travel_days_in_transit'],
    ['distance_gc', 'Great-circle distance traveled', 'distance_transit', 10, 'great_circle_distance'],
    ['distance_co2', 'Estimated CO2 emissions', 'distance_transit', 11, 'estimated_co2'],
    ['time_year', 'Trips this year', 'time', 1, 'trips_this_year'],
    ['time_month', 'Trips this month', 'time', 2, 'trips_this_month'],
    ['time_days', 'Days traveled this year', 'time', 3, 'days_traveled_this_year'],
    ['time_years', 'Years with at least one trip', 'time', 4, 'years_with_trip'],
    ['time_streak', 'Current travel streak by year', 'time', 5, 'current_travel_streak_by_year'],
    ['time_gap_long', 'Longest gap between trips', 'time', 6, 'longest_gap_between_trips'],
    ['time_gap_short', 'Shortest gap between trips', 'time', 7, 'shortest_gap_between_trips'],
    ['time_favorite', 'Favorite travel month', 'time', 8, 'favorite_travel_month'],
    ['time_most_month', 'Most traveled month', 'time', 9, 'most_traveled_month'],
    ['time_least_month', 'Least traveled month', 'time', 10, 'least_traveled_month'],
    ['time_most_year', 'Most traveled year', 'time', 11, 'most_traveled_year'],
    ['time_avg_trips', 'Average trips per year', 'time', 12, 'average_trips_per_year'],
    ['time_avg_days', 'Average travel days per year', 'time', 13, 'average_travel_days_per_year'],
    ['time_seasons', 'Trips by season', 'time', 14, 'trips_by_season'],
    ['geo_continents', 'Continents visited', 'geography', 1, 'continents_visited'],
    ['geo_regions', 'Regions visited', 'geography', 2, 'regions_visited'],
    ['geo_states', 'States / provinces / territories visited', 'geography', 3, 'states_visited'],
    ['geo_unesco', 'UNESCO sites visited', 'geography', 4, 'unesco_sites_visited'],
    ['geo_capitals', 'Capitals visited', 'geography', 5, 'capitals_visited'],
    ['geo_unique', 'Number of unique places pinned on map', 'geography', 6, 'unique_places_pinned'],
    ['geo_north', 'Northernmost point visited', 'geography', 7, 'northernmost_point'],
    ['geo_south', 'Southernmost point visited', 'geography', 8, 'southernmost_point'],
    ['geo_east', 'Easternmost point visited', 'geography', 9, 'easternmost_point'],
    ['geo_west', 'Westernmost point visited', 'geography', 10, 'westernmost_point'],
    ['geo_high', 'Highest elevation reached', 'geography', 11, 'highest_elevation'],
    ['geo_low', 'Lowest elevation visited', 'geography', 12, 'lowest_elevation'],
    ['geo_close_home', 'Closest destination to home', 'geography', 13, 'closest_destination_to_home'],
    ['geo_far_home', 'Farthest destination from home', 'geography', 14, 'farthest_destination_from_home'],
    ['geo_timezones', 'Number of time zones visited', 'geography', 15, 'timezones_visited'],
    ['geo_timezone_jump', 'Largest time zone jump in one trip', 'geography', 16, 'largest_timezone_jump'],
    ['geo_lat', 'Total latitude range covered', 'geography', 17, 'total_latitude_range'],
    ['geo_lon', 'Total longitude range covered', 'geography', 18, 'total_longitude_range'],
    ['geo_hemi', 'Hemisphere coverage', 'geography', 19, 'hemisphere_coverage'],
    ['passport_air', 'Border crossings by air', 'passport_borders_logistics', 1, 'border_crossings_by_air'],
    ['passport_revisit', 'Countries revisited after first visit', 'passport_borders_logistics', 2, 'countries_revisited_after_first_visit'],
    ['michelin_total', 'Michelin-starred restaurants visited', 'michelin', 1, 'michelin_sites_visited'],
    ['michelin_countries', 'Countries with Michelin-starred restaurant visits', 'michelin', 2, 'michelin_countries'],
    ['michelin_first', 'First Michelin-starred restaurant visit date', 'michelin', 3, 'first_michelin_visit_date'],
    ['michelin_latest', 'Latest Michelin-starred restaurant visit date', 'michelin', 4, 'latest_michelin_visit_date'],
].map(([id, label, section, priority, selector]) => ({
    id,
    label,
    section: section,
    priority: priority,
    description: label,
    selector: selector,
    visibilityTier: 'expandable',
}));
const unsupportedDefinitions = [
    { id: 'unsupported_trip_nights', label: 'Total nights away from home', section: 'trips', priority: 100, description: 'Requires trip-duration or stay data.', selector: 'unsupported', visibilityTier: 'expandable' },
    { id: 'unsupported_trip_lengths', label: 'Longest / shortest / average trip length', section: 'trips', priority: 101, description: 'Requires trip-duration data.', selector: 'unsupported', visibilityTier: 'expandable' },
    { id: 'unsupported_transit_time', label: 'Transit time / overnight transit / layover duration', section: 'distance_transit', priority: 102, description: 'Requires time-of-day transit data.', selector: 'unsupported', visibilityTier: 'expandable' },
    { id: 'unsupported_geo_collections', label: 'Beaches / islands / mountains / wonders / map coverage', section: 'geography', priority: 103, description: 'Current datasets do not classify these reliably.', selector: 'unsupported', visibilityTier: 'expandable' },
    { id: 'unsupported_passport', label: 'Passport / visa / language logistics', section: 'passport_borders_logistics', priority: 104, description: 'Passport and visa logistics are not tracked.', selector: 'unsupported', visibilityTier: 'expandable' },
    { id: 'unsupported_michelin_city_trip', label: 'Michelin cities and per-trip rollups', section: 'michelin', priority: 105, description: 'Current Michelin place records do not consistently expose city or trip linkage.', selector: 'unsupported', visibilityTier: 'expandable' },
    { id: 'unsupported_gamified', label: 'Achievements / gamified stats', section: 'achievements_gamified', priority: 106, description: 'Gamified metrics are intentionally excluded from this feature.', selector: 'unsupported', visibilityTier: 'expandable' },
];
const registry = [...supportedDefinitions, ...expandableDefinitions, ...unsupportedDefinitions];
export function buildTravelStatsModel(args) {
    const context = buildContext(args.places, args.visits, args.tripLogs);
    const evaluated = registry
        .map((definition) => {
        const result = calculators[definition.selector](context);
        if (!result)
            return null;
        return { ...definition, displayValue: result.displayValue, detail: result.detail, sentence: result.sentence };
    })
        .filter((item) => Boolean(item));
    return {
        heroStats: evaluated.filter((stat) => stat.visibilityTier === 'hero').sort((a, b) => a.priority - b.priority),
        highlightStats: evaluated.filter((stat) => stat.visibilityTier === 'highlight').sort((a, b) => a.priority - b.priority),
        sections: Object.keys(SECTION_LABELS)
            .map((sectionId) => ({
            id: sectionId,
            label: SECTION_LABELS[sectionId],
            stats: evaluated.filter((stat) => stat.visibilityTier === 'expandable' && stat.section === sectionId).sort((a, b) => a.priority - b.priority),
        }))
            .filter((section) => section.stats.length > 0),
        unsupportedStatIds: unsupportedDefinitions.map((definition) => definition.id),
    };
}
