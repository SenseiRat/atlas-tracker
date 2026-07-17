import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { ActiveProfile, Place, Stats, TripLog, Visit } from '../types';

type UseProfileDataOptions = {
  profileId: ActiveProfile;
  enabled: boolean;
  canEditSelectedProfile: boolean;
  setUiError: (message: string | null) => void;
};

/**
 * Visits, stats, and trip logs for the active profile (or the collective demo
 * view when no profile is selected), plus the visit toggle flow.
 */
export function useProfileData({ profileId, enabled, canEditSelectedProfile, setUiError }: UseProfileDataOptions) {
  const profileDataRequestRef = useRef(0);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tripLogs, setTripLogs] = useState<TripLog[]>([]);

  const refreshVisitsStatsAndTrips = async (active: ActiveProfile) => {
    const visitsPath = active === null ? '/api/visits' : `/api/visits?profile_id=${active}`;
    const statsPath = active === null ? '/api/stats' : `/api/stats?profile_id=${active}`;
    const tripsPath = active === null ? '/api/trip-logs' : `/api/trip-logs?profile_id=${active}`;

    // Guard against out-of-order responses: only the most recent call applies
    // its results, so rapidly switching profiles can't leave stale data.
    const seq = ++profileDataRequestRef.current;
    const [visitsData, statsData, tripsData] = await Promise.all([
      api<Visit[]>(visitsPath),
      api<Stats>(statsPath),
      api<TripLog[]>(tripsPath),
    ]);
    if (seq !== profileDataRequestRef.current) return;

    setVisits(visitsData);
    setStats(statsData);
    setTripLogs(tripsData);
  };

  useEffect(() => {
    if (!enabled) return;
    refreshVisitsStatsAndTrips(profileId).catch(() => {
      setVisits([]);
      setStats(null);
      setTripLogs([]);
      setUiError('Unable to load visits/trips/stats.');
    });
  }, [profileId, enabled]);

  const visitedIds = useMemo(() => {
    if (profileId === null) {
      return new Set(visits.map((visit) => visit.place_id));
    }
    return new Set(visits.filter((visit) => visit.profile_id === profileId).map((visit) => visit.place_id));
  }, [visits, profileId]);

  const visitedCountryCodes = useMemo(() => {
    const codes = new Set<string>();
    visitedIds.forEach((id) => {
      if (id.startsWith('country-')) {
        codes.add(id.replace('country-', '').toUpperCase());
      }
    });
    return codes;
  }, [visitedIds]);

  const isCollectiveDemoMode = profileId === null;
  const isMultiProfileView = isCollectiveDemoMode;
  const activeVisits = useMemo(
    () => (isMultiProfileView ? visits : visits.filter((visit) => visit.profile_id === profileId)),
    [isMultiProfileView, visits, profileId],
  );
  const activeTrips = useMemo(
    () => (isMultiProfileView ? tripLogs : tripLogs.filter((trip) => trip.profile_id === profileId)),
    [isMultiProfileView, tripLogs, profileId],
  );
  const stateVisitById = useMemo(
    () => new Map(activeVisits.filter((visit) => visit.place_id.startsWith('state-')).map((visit) => [visit.place_id, visit] as const)),
    [activeVisits],
  );

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

  return {
    visits,
    setVisits,
    stats,
    setStats,
    tripLogs,
    setTripLogs,
    refreshVisitsStatsAndTrips,
    visitedIds,
    visitedCountryCodes,
    isCollectiveDemoMode,
    isMultiProfileView,
    activeVisits,
    activeTrips,
    stateVisitById,
    onToggleVisit,
  };
}
