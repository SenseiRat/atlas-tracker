import type { useTripForm } from '../hooks/useTripForm';

type TripFormProps = {
  trip: ReturnType<typeof useTripForm>;
  airportLabelById: Map<string, string>;
};

export function TripForm({ trip, airportLabelById }: TripFormProps) {
  const {
    tripForm,
    setTripForm,
    originAirportOptions,
    destinationAirportOptions,
    layoverAirportOptions,
    resolveAirportId,
    handleCreateTripLog,
  } = trip;

  return (
    <div className="trip-form">
      <datalist id="airport-options-origin">
        {originAirportOptions.map((airport) => (
          <option key={airport.id} value={airportLabelById.get(airport.id) ?? ''} />
        ))}
      </datalist>
      <datalist id="airport-options-destination">
        {destinationAirportOptions.map((airport) => (
          <option key={airport.id} value={airportLabelById.get(airport.id) ?? ''} />
        ))}
      </datalist>
      {tripForm.layover_queries.map((query, index) => (
        <datalist id={`airport-options-layover-${index}`} key={`airport-options-${index}`}>
          {(layoverAirportOptions[index] ?? []).map((airport) => (
            <option key={airport.id} value={airportLabelById.get(airport.id) ?? ''} />
          ))}
        </datalist>
      ))}

      <label>
        Date (optional)
        <input
          type="date"
          value={tripForm.flown_on}
          onChange={(event) => setTripForm((prev) => ({ ...prev, flown_on: event.target.value }))}
        />
      </label>

      <label>
        Origin
        <input
          type="text"
          list="airport-options-origin"
          placeholder="Type code, airport name, or city/state"
          value={tripForm.origin_query}
          onChange={(event) => {
            const value = event.target.value;
            setTripForm((prev) => ({
              ...prev,
              origin_query: value,
              origin_place_id: resolveAirportId(value),
            }));
          }}
        />
      </label>

      <label>
        Destination
        <input
          type="text"
          list="airport-options-destination"
          placeholder="Type code, airport name, or city/state"
          value={tripForm.destination_query}
          onChange={(event) => {
            const value = event.target.value;
            setTripForm((prev) => ({
              ...prev,
              destination_query: value,
              destination_place_id: resolveAirportId(value),
            }));
          }}
        />
      </label>

      {tripForm.layovers.map((layoverId, index) => (
        <label key={`layover-${index}`}>
          Layover {index + 1} (optional)
          <div className="layover-row">
            <input
              type="text"
              list={`airport-options-layover-${index}`}
              placeholder="Type code, airport name, or city/state"
              value={tripForm.layover_queries[index]}
              onChange={(event) =>
                setTripForm((prev) => ({
                  ...prev,
                  layovers: prev.layovers.map((item, itemIndex) =>
                    itemIndex === index ? resolveAirportId(event.target.value) : item,
                  ),
                  layover_queries: prev.layover_queries.map((item, itemIndex) =>
                    itemIndex === index ? event.target.value : item,
                  ),
                }))
              }
            />
            <button
              type="button"
              onClick={() =>
                setTripForm((prev) => ({
                  ...prev,
                  layovers: prev.layovers.filter((_, itemIndex) => itemIndex !== index),
                  layover_queries: prev.layover_queries.filter(
                    (_, itemIndex) => itemIndex !== index,
                  ),
                }))
              }
              disabled={tripForm.layovers.length <= 1}
            >
              Remove
            </button>
          </div>
        </label>
      ))}

      <div className="trip-form-actions">
        <button
          type="button"
          onClick={() =>
            setTripForm((prev) => ({
              ...prev,
              layovers: [...prev.layovers, ''],
              layover_queries: [...prev.layover_queries, ''],
            }))
          }
        >
          Add layover
        </button>
        <button type="button" className="accent-button" onClick={handleCreateTripLog}>
          Save trip log
        </button>
      </div>
    </div>
  );
}
