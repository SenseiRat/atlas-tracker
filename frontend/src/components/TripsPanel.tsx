import { TripForm } from './TripForm';
import { formatDistance } from '../lib/format';
import type { useTripForm } from '../hooks/useTripForm';
import type { ActiveProfile, MeasurementSystem, TripLog } from '../types';

type TripsPanelProps = {
  trip: ReturnType<typeof useTripForm>;
  tripLogs: TripLog[];
  profileId: ActiveProfile;
  canEditSelectedProfile: boolean;
  measurementSystem: MeasurementSystem;
  airportLabelById: Map<string, string>;
};

export function TripsPanel({
  trip,
  tripLogs,
  profileId,
  canEditSelectedProfile,
  measurementSystem,
  airportLabelById,
}: TripsPanelProps) {
  const { showTripForm, setShowTripForm, handleDeleteTripLog } = trip;

  return (
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

      {showTripForm && <TripForm trip={trip} airportLabelById={airportLabelById} />}

      <ul className="trip-list">
        {tripLogs.map((tripLog) => (
          <li key={tripLog.id} className="trip-card">
            <div className="trip-main">
              <strong>{tripLog.route_points.map((point) => point.name).join(' -> ')}</strong>
              <span>{formatDistance(tripLog.estimated_miles, measurementSystem)} estimated</span>
              <small>{tripLog.flown_on ? `Date: ${tripLog.flown_on}` : 'Date not provided'}</small>
            </div>
            {typeof profileId === 'number' && canEditSelectedProfile && (
              <button type="button" onClick={() => handleDeleteTripLog(tripLog.id)}>
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
