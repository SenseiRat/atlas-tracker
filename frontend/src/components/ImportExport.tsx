import type { ChangeEvent } from 'react';
import { api } from '../api/client';
import { useToasts } from './ui/toast';
import type { ActiveProfile } from '../types';

type ImportExportProps = {
  profileId: ActiveProfile;
  canEditSelectedProfile: boolean;
  refreshVisitsStatsAndTrips: (active: ActiveProfile) => Promise<void>;
  setUiError: (message: string | null) => void;
};

/** Export/import the active profile's visits and trips as JSON. */
export function ImportExport({ profileId, canEditSelectedProfile, refreshVisitsStatsAndTrips, setUiError }: ImportExportProps) {
  const { pushToast } = useToasts();

  const handleExport = async () => {
    if (typeof profileId !== 'number') return;

    try {
      const data = await api(`/api/export?profile_id=${profileId}`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `world-visited-profile-${profileId}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      pushToast('Exported profile data.', 'success');
    } catch {
      setUiError('Could not export data.');
    }
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    if (typeof profileId !== 'number') return;

    const file = input.files?.[0];
    if (!file) return;

    const body = new FormData();
    body.append('file', file);

    try {
      const response = await fetch(`/api/import?profile_id=${profileId}`, { method: 'POST', body });
      if (!response.ok) {
        throw new Error('Import failed');
      }
      const summary = (await response.json()) as { imported_visits?: number; imported_trip_logs?: number };
      await refreshVisitsStatsAndTrips(profileId);
      pushToast(
        `Imported ${summary.imported_visits ?? 0} visits and ${summary.imported_trip_logs ?? 0} trips.`,
        'success',
      );
    } catch {
      setUiError('Could not import data.');
    } finally {
      // Reset so selecting the same file again still fires a change event.
      input.value = '';
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleExport}
        disabled={typeof profileId !== 'number'}
        title={typeof profileId === 'number' ? undefined : 'Select a profile to export its data'}
      >
        Export JSON
      </button>
      <label
        className="import-label"
        title={typeof profileId === 'number' && canEditSelectedProfile ? undefined : 'Switch to a profile you own to import data'}
      >
        Import JSON
        <input
          type="file"
          accept="application/json"
          onChange={handleImport}
          disabled={typeof profileId !== 'number' || !canEditSelectedProfile}
        />
      </label>
    </>
  );
}
