import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import { ImportExport } from './ImportExport';
import { normalizeHexColor } from '../lib/colors';
import { formatDistance } from '../lib/format';
import type { useProfiles } from '../hooks/useProfiles';
import type { ActiveProfile, AuthSession, MeasurementSystem, Stats, ThemeMode } from '../types';

type HeaderProps = {
  authSession: AuthSession | null;
  themeMode: ThemeMode;
  setThemeMode: Dispatch<SetStateAction<ThemeMode>>;
  onOpenSettings: () => void;
  onOpenLogin: () => void;
  handleLogout: () => void;
  profilesApi: ReturnType<typeof useProfiles>;
  countryNameByCode: Map<string, string>;
  stats: Stats | null;
  measurementSystem: MeasurementSystem;
  refreshVisitsStatsAndTrips: (active: ActiveProfile) => Promise<void>;
  setUiError: (message: string | null) => void;
};

/** App header: brand, auth controls, profile selector/actions, and stat cards. */
export function Header({
  authSession,
  themeMode,
  setThemeMode,
  onOpenSettings,
  onOpenLogin,
  handleLogout,
  profilesApi,
  countryNameByCode,
  stats,
  measurementSystem,
  refreshVisitsStatsAndTrips,
  setUiError,
}: HeaderProps) {
  const {
    profileId,
    setProfileId,
    selectedProfile,
    canEditSelectedProfile,
    ownedProfiles,
    publicProfiles,
    openCreateProfileModal,
    handleEditProfile,
    handleDeleteProfile,
  } = profilesApi;

  return (
      <header className="header">
        <div className="brand-panel">
          <div className="brand-heading">
            <h1>AtlasTracker</h1>
            <div className="auth-controls">
              <span className="auth-user">
                {authSession?.authenticated
                  ? authSession.user?.display_name || authSession.user?.username || authSession.user?.email || 'Signed in'
                  : 'Not logged in'}
              </span>
              <button
                type="button"
                className="theme-toggle"
                onClick={() => setThemeMode((prev) => (prev === 'dark' ? 'light' : 'dark'))}
              >
                {themeMode === 'dark' ? 'Light' : 'Dark'}
              </button>
              <button type="button" className="theme-toggle" onClick={onOpenSettings}>
                Settings
              </button>
              {authSession?.authenticated ? (
                <button type="button" className="theme-toggle" onClick={handleLogout}>
                  Log out
                </button>
              ) : authSession?.oidc_enabled ? (
                <button type="button" className="theme-toggle" onClick={() => (window.location.href = '/api/auth/login')}>
                  Log in
                </button>
              ) : (
                <button
                  type="button"
                  className="theme-toggle"
                  onClick={onOpenLogin}
                  disabled={!authSession?.has_local_users}
                >
                  Log in
                </button>
              )}
            </div>
          </div>

          <div className="profile-panel profile-panel-compact">
            <div className="profile-compact-grid">
              <label className="profile-field profile-selector summary-card">
                <span>Profile</span>
                <strong>{selectedProfile?.name ?? 'Demo mode'}</strong>
                <select
                  value={profileId ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value) {
                      setProfileId(null);
                    } else {
                      setProfileId(Number(value));
                    }
                  }}
                >
                  <option value="">Demo mode</option>
                  {ownedProfiles.length > 0 && (
                    <optgroup label="Your profiles">
                      {ownedProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {publicProfiles.length > 0 && (
                    <optgroup label="Public profiles">
                      {publicProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <small>Choose the active atlas view</small>
              </label>

              <div className="profile-info-card summary-card">
                <span>Profile info</span>
                <strong>
                  {selectedProfile?.is_owned ? 'Owned by you' : selectedProfile ? 'Public profile view' : 'Collective server atlas'}
                </strong>
                <small>
                  {selectedProfile
                    ? `${selectedProfile.is_public ? 'Public' : 'Private'} • ${countryNameByCode.get((selectedProfile.home_country_code ?? '').toUpperCase()) ?? 'No home country set'}`
                    : 'Attributed colors reflect contributing profiles'}
                </small>
                {selectedProfile && (
                  <span className="profile-color-indicator" aria-label="Profile color">
                    <span
                      className="profile-color-indicator__swatch"
                      style={{ '--swatch-color': normalizeHexColor(selectedProfile.color) } as CSSProperties}
                    />
                    <span>Profile color</span>
                  </span>
                )}
              </div>
            </div>

            <div className="profile-actions">
              {authSession?.authenticated && (
                <button type="button" onClick={openCreateProfileModal}>
                  New profile
                </button>
              )}
              <button
                type="button"
                onClick={handleEditProfile}
                disabled={typeof profileId !== 'number' || !canEditSelectedProfile}
                title={canEditSelectedProfile ? undefined : 'Switch to a profile you own to edit it'}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={handleDeleteProfile}
                disabled={typeof profileId !== 'number' || !canEditSelectedProfile}
                title={canEditSelectedProfile ? undefined : 'Switch to a profile you own to delete it'}
              >
                Delete
              </button>
              <ImportExport
                profileId={profileId}
                canEditSelectedProfile={canEditSelectedProfile}
                refreshVisitsStatsAndTrips={refreshVisitsStatsAndTrips}
                setUiError={setUiError}
              />
            </div>
          </div>
        </div>

        <div className="highlights-rail">
          <div className="stat-card">
            <span>Countries</span>
            <strong>
              {stats?.countries.visited ?? 0} / {stats?.countries.total ?? 0}
            </strong>
            <small>{stats?.countries.percent ?? 0}% visited</small>
          </div>
          <div className="stat-card">
            <span>Continents</span>
            <strong>
              {stats?.continents.visited ?? 0} / {stats?.continents.total ?? 0}
            </strong>
            <small>Global coverage</small>
          </div>
          <div className="stat-card">
            <span>Trips / Miles</span>
            <strong>{stats?.trip_logs.count ?? 0}</strong>
            <small>{formatDistance(stats?.trip_logs.estimated_miles ?? 0, measurementSystem)} total</small>
          </div>
          <div className="stat-card">
            <span>States</span>
            <strong>
              {stats?.states.visited ?? 0} / {stats?.states.total ?? 0}
            </strong>
            <small>Visited state or province regions</small>
          </div>
          <div className="stat-card">
            <span>Cities / Airports</span>
            <strong>
              {(stats?.cities.visited ?? 0) + (stats?.airports.visited ?? 0)}
            </strong>
            <small>
              {(stats?.cities.visited ?? 0).toLocaleString()} cities and {(stats?.airports.visited ?? 0).toLocaleString()} airports
            </small>
          </div>
          <div className="stat-card">
            <span>Leaderboard</span>
            <strong>
              {stats?.leaderboard.current_profile?.eligible
                ? `#${stats.leaderboard.current_profile.overall_rank ?? '--'}`
                : '--'}
            </strong>
            <small>
              {stats?.leaderboard.current_profile?.eligible
                ? `${Math.round(stats.leaderboard.current_profile.overall_score).toLocaleString()} score`
                : selectedProfile
                  ? 'Set profile public to rank'
                  : 'Public profiles only'}
            </small>
          </div>
        </div>
      </header>
  );
}
