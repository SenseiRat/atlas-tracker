import { useCallback, useMemo, useRef, useState } from 'react';
import { useToasts } from './components/ui/toast';
import { AchievementsPanel } from './AchievementsPanel';
import { TravelStatsPanel } from './TravelStatsPanel';
import { buildAchievementModel } from './achievements';
import { buildTravelStatsModel } from './travelStats';
import { useAppPreferences } from './hooks/useAppPreferences';
import { useSession } from './hooks/useSession';
import { usePlaces } from './hooks/usePlaces';
import { useProfiles } from './hooks/useProfiles';
import { useProfileData } from './hooks/useProfileData';
import { useAdmin } from './hooks/useAdmin';
import { useTripForm } from './hooks/useTripForm';
import { usePlaceFilters } from './hooks/usePlaceFilters';
import { MapView, type MapViewHandle } from './components/map/MapView';
import { PlaceDetailPanel, SiteDetailPanel } from './components/PlaceDetailPanel';
import { LeaderboardPanel } from './components/LeaderboardPanel';
import { TripsPanel } from './components/TripsPanel';
import { SettingsModal } from './components/SettingsModal';
import { FirstRunSetup, LoginModal } from './components/AuthModals';
import { ProfileModals } from './components/ProfileModals';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import type { MainView, Place } from './types';

function App() {
  const mapViewRef = useRef<MapViewHandle | null>(null);
  const { pushToast } = useToasts();
  // Surface errors as dismissible, auto-clearing toasts instead of a persistent
  // banner that could hide behind modals and never clear.
  const setUiError = useCallback((message: string | null) => {
    if (message) pushToast(message, 'error');
  }, [pushToast]);
  const [showSettingsOverlay, setShowSettingsOverlay] = useState(false);
  const session = useSession({
    setUiError,
    refreshProfiles: () => refreshProfiles(),
    refreshAdminData: () => admin.refreshAdminData(),
    setProfileId: (id) => setProfileId(id),
    onLoggedOut: () => {
      setProfiles([]);
      setProfileId(null);
      setVisits([]);
      setTripLogs([]);
      setStats(null);
      setShowSettingsOverlay(false);
    },
  });
  const {
    authLoading,
    authSession,
    isAdmin,
    refreshAuthSession,
    setShowLoginModal,
    isAuthSubmitting,
    accountDisplayName,
    setAccountDisplayName,
    accountDefaultProfileId,
    setAccountDefaultProfileId,
    accountPassword,
    setAccountPassword,
    accountConfirmPassword,
    setAccountConfirmPassword,
    handleLogout,
    saveAccount,
  } = session;
  const { themeMode, setThemeMode, measurementSystem, setMeasurementSystem, mapLabelLanguage, setMapLabelLanguage } =
    useAppPreferences(authSession);
  const {
    places,
    sortedPlaces,
    placeSearchTextByType,
    airportLabelById,
    airportAutocomplete,
    resolveAirportId,
    siteCountryOptions,
    countryNameByCode,
    countryCodeByName,
    stateNameByCountryAndCode,
    pointLookup,
  } = usePlaces({ enabled: !authLoading, setUiError });
  const profilesApi = useProfiles({ authSession, enabled: !authLoading, themeMode, setUiError });
  const {
    setProfiles,
    profileId,
    setProfileId,
    nextSuggestedProfileColor,
    profileVisualsById,
    selectedProfile,
    canEditSelectedProfile,
    ownedProfiles,
    publicProfiles,
    refreshProfiles,
  } = profilesApi;
  const {
    setVisits,
    stats,
    setStats,
    tripLogs,
    setTripLogs,
    refreshVisitsStatsAndTrips,
    visitedIds,
    visitedCountryCodes,
    isMultiProfileView,
    activeVisits,
    activeTrips,
    stateVisitById,
    onToggleVisit,
  } = useProfileData({ profileId, enabled: !authLoading, canEditSelectedProfile, setUiError });
  const admin = useAdmin({
    isAdmin,
    authSession,
    refreshAuthSession,
    refreshProfiles,
    nextSuggestedProfileColor,
    pushToast,
    setUiError,
  });
  const trip = useTripForm({
    profileId,
    canEditSelectedProfile,
    airportAutocomplete,
    resolveAirportId,
    refreshVisitsStatsAndTrips,
    setUiError,
  });
  const filters = usePlaceFilters({
    places,
    sortedPlaces,
    placeSearchTextByType,
    visitedIds,
    visitedCountryCodes,
    countryCodeByName,
    countryNameByCode,
    airportAutocomplete,
  });
  const [mainView, setMainView] = useState<MainView>('map');
  const [showTripRoutes, setShowTripRoutes] = useState(false);
  const [selectedMapPlaceId, setSelectedMapPlaceId] = useState<string | null>(null);

  const selectedMapPlace = useMemo(
    () => (selectedMapPlaceId ? pointLookup.get(selectedMapPlaceId) ?? null : null),
    [pointLookup, selectedMapPlaceId],
  );
  const travelStatsModel = useMemo(
    () =>
      buildTravelStatsModel({
        places,
        visits: activeVisits,
        tripLogs: activeTrips,
        measurementSystem,
        homeCountryCode: selectedProfile?.home_country_code ?? undefined,
      }),
    [activeTrips, activeVisits, measurementSystem, places, selectedProfile?.home_country_code],
  );
  const achievementModel = useMemo(
    () =>
      buildAchievementModel({
        places,
        visits: activeVisits,
        tripLogs: activeTrips,
      }),
    [activeTrips, activeVisits, places],
  );

  const focusOnPlace = (place: Place) => {
    void mapViewRef.current?.focusOnPlace(place);
  };

  const handleAccountSave = () => saveAccount({ themeMode, measurementSystem });

  if (authLoading) {
    return (
      <div className="app" data-theme={themeMode}>
        <div className="first-run-modal">
          <div className="first-run-card">
            <h2>Loading</h2>
            <p>Checking authentication session.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app" data-theme={themeMode}>
      <FirstRunSetup session={session} />

      <LoginModal session={session} />

      <ProfileModals profilesApi={profilesApi} countries={sortedPlaces.country} />


      <Header
        authSession={authSession}
        themeMode={themeMode}
        setThemeMode={setThemeMode}
        onOpenSettings={() => setShowSettingsOverlay(true)}
        onOpenLogin={() => setShowLoginModal(true)}
        handleLogout={handleLogout}
        profilesApi={profilesApi}
        countryNameByCode={countryNameByCode}
        stats={stats}
        measurementSystem={measurementSystem}
        refreshVisitsStatsAndTrips={refreshVisitsStatsAndTrips}
        setUiError={setUiError}
      />

      <div className="content">
        <Sidebar
          filters={filters}
          visitedIds={visitedIds}
          profileId={profileId}
          canEditSelectedProfile={canEditSelectedProfile}
          onToggleVisit={onToggleVisit}
          focusOnPlace={focusOnPlace}
          airportLabelById={airportLabelById}
          resolveAirportId={resolveAirportId}
          siteCountryOptions={siteCountryOptions}
          countryNameByCode={countryNameByCode}
          stateNameByCountryAndCode={stateNameByCountryAndCode}
        />

        <main className="map-area">
          <div className="main-tabs">
            <button
              type="button"
              className={mainView === 'map' ? 'active' : ''}
              onClick={() => setMainView('map')}
            >
              Map
            </button>
            <button
              type="button"
              className={mainView === 'trips' ? 'active' : ''}
              onClick={() => setMainView('trips')}
            >
              Trip Logs
            </button>
            <button
              type="button"
              className={mainView === 'stats' ? 'active' : ''}
              onClick={() => setMainView('stats')}
            >
              Stats
            </button>
            <button
              type="button"
              className={mainView === 'achievements' ? 'active' : ''}
              onClick={() => setMainView('achievements')}
            >
              Achievements
            </button>
            <button
              type="button"
              className={mainView === 'leaderboard' ? 'active' : ''}
              onClick={() => setMainView('leaderboard')}
            >
              Leaderboard
            </button>
          </div>

          {mainView === 'map' && (
            <div className="map-controls">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showTripRoutes}
                  onChange={(event) => setShowTripRoutes(event.target.checked)}
                />
                Show trip routes
              </label>
            </div>
          )}

          <MapView
            ref={mapViewRef}
            authLoading={authLoading}
            themeMode={themeMode}
            mapLabelLanguage={mapLabelLanguage}
            mainView={mainView}
            showTripRoutes={showTripRoutes}
            profileId={profileId}
            isMultiProfileView={isMultiProfileView}
            activeVisits={activeVisits}
            activeTrips={activeTrips}
            profileVisualsById={profileVisualsById}
            pointLookup={pointLookup}
            stateVisitById={stateVisitById}
            selectedMapPlaceId={selectedMapPlaceId}
            setSelectedMapPlaceId={setSelectedMapPlaceId}
            setUiError={setUiError}
          />
          {mainView === 'map' && selectedMapPlace?.id.startsWith('site-') && (
            <SiteDetailPanel place={selectedMapPlace} onClose={() => setSelectedMapPlaceId(null)} />
          )}
          {mainView === 'map' &&
            selectedMapPlace &&
            (selectedMapPlace.id.startsWith('city-') || selectedMapPlace.id.startsWith('airport-')) && (
              <PlaceDetailPanel
                place={selectedMapPlace}
                profileId={profileId}
                canEditSelectedProfile={canEditSelectedProfile}
                visitedIds={visitedIds}
                countryNameByCode={countryNameByCode}
                measurementSystem={measurementSystem}
                onToggleVisit={onToggleVisit}
                onClose={() => setSelectedMapPlaceId(null)}
              />
            )}

          {mainView === 'trips' && (
            <TripsPanel
              trip={trip}
              tripLogs={tripLogs}
              profileId={profileId}
              canEditSelectedProfile={canEditSelectedProfile}
              measurementSystem={measurementSystem}
              airportLabelById={airportLabelById}
            />
          )}

          {mainView === 'stats' && (
            <div className="detail-panel">
              <div className="panel-header">
                <div>
                  <h3>Travel Stats</h3>
                  <p>Derived travel metrics from your logged trips, visits, and place metadata.</p>
                </div>
              </div>
              <TravelStatsPanel model={travelStatsModel} />
            </div>
          )}

          {mainView === 'achievements' && (
            <div className="detail-panel">
              <div className="panel-header">
                <div>
                  <h3>Achievements</h3>
                  <p>Tiered progress and milestones based on the travel data this profile already tracks.</p>
                </div>
              </div>
              <AchievementsPanel model={achievementModel} />
            </div>
          )}

          {mainView === 'leaderboard' && <LeaderboardPanel stats={stats} measurementSystem={measurementSystem} />}

        </main>
      </div>

      <SettingsModal
        open={showSettingsOverlay}
        onClose={() => setShowSettingsOverlay(false)}
        authSession={authSession}
        isAuthSubmitting={isAuthSubmitting}
        accountPassword={accountPassword}
        setAccountPassword={setAccountPassword}
        accountConfirmPassword={accountConfirmPassword}
        setAccountConfirmPassword={setAccountConfirmPassword}
        accountDisplayName={accountDisplayName}
        setAccountDisplayName={setAccountDisplayName}
        accountDefaultProfileId={accountDefaultProfileId}
        setAccountDefaultProfileId={setAccountDefaultProfileId}
        themeMode={themeMode}
        setThemeMode={setThemeMode}
        measurementSystem={measurementSystem}
        setMeasurementSystem={setMeasurementSystem}
        mapLabelLanguage={mapLabelLanguage}
        setMapLabelLanguage={setMapLabelLanguage}
        ownedProfiles={ownedProfiles}
        publicProfiles={publicProfiles}
        handleAccountSave={handleAccountSave}
        handleLogout={handleLogout}
        onOpenLogin={() => {
          setShowSettingsOverlay(false);
          setShowLoginModal(true);
        }}
        isAdmin={isAdmin}
        admin={admin}
        countries={sortedPlaces.country}
      />
    </div>
  );
}

export default App;
