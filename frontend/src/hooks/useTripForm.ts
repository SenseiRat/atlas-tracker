import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { useConfirm } from '../components/ui/ConfirmDialog';
import type { ActiveProfile, Place, TripLog } from '../types';

type UseTripFormOptions = {
  profileId: ActiveProfile;
  canEditSelectedProfile: boolean;
  airportAutocomplete: (input: string) => Place[];
  resolveAirportId: (value: string) => string;
  refreshVisitsStatsAndTrips: (active: ActiveProfile) => Promise<void>;
  setUiError: (message: string | null) => void;
};

/**
 * Trip-log form state (origin/destination/layovers) and the create/delete
 * trip-log flows.
 */
export function useTripForm({
  profileId,
  canEditSelectedProfile,
  airportAutocomplete,
  resolveAirportId,
  refreshVisitsStatsAndTrips,
  setUiError,
}: UseTripFormOptions) {
  const confirm = useConfirm();
  const [showTripForm, setShowTripForm] = useState(false);
  const [tripForm, setTripForm] = useState({
    flown_on: '',
    origin_place_id: '',
    origin_query: '',
    destination_place_id: '',
    destination_query: '',
    layovers: [''],
    layover_queries: [''],
  });

  // Memoize the trip-form datalist suggestions so they only recompute when the
  // relevant query changes, not on every unrelated re-render.
  const originAirportOptions = useMemo(() => airportAutocomplete(tripForm.origin_query), [airportAutocomplete, tripForm.origin_query]);
  const destinationAirportOptions = useMemo(() => airportAutocomplete(tripForm.destination_query), [airportAutocomplete, tripForm.destination_query]);
  const layoverAirportOptions = useMemo(
    () => tripForm.layover_queries.map((query) => airportAutocomplete(query)),
    [airportAutocomplete, tripForm.layover_queries],
  );

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
    const ok = await confirm({
      title: 'Delete trip log',
      message: 'Delete this trip log?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;

    try {
      await api(`/api/trip-logs/${tripLogId}`, { method: 'DELETE' });
      await refreshVisitsStatsAndTrips(profileId);
    } catch {
      setUiError('Could not delete trip log.');
    }
  };

  return {
    showTripForm,
    setShowTripForm,
    tripForm,
    setTripForm,
    originAirportOptions,
    destinationAirportOptions,
    layoverAirportOptions,
    resolveAirportId,
    handleCreateTripLog,
    handleDeleteTripLog,
  };
}
