import { useEffect, useState } from 'react';
import type { AuthSession, MeasurementSystem, ThemeMode } from '../types';

/**
 * Theme and measurement-system preferences, persisted to localStorage and
 * synced from the signed-in user's saved preferences.
 */
export function useAppPreferences(authSession: AuthSession | null) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem('tracker-theme');
    return stored === 'light' ? 'light' : 'dark';
  });
  const [measurementSystem, setMeasurementSystem] = useState<MeasurementSystem>(() => {
    const stored = localStorage.getItem('tracker-measurement-system');
    return stored === 'metric' ? 'metric' : 'imperial';
  });

  useEffect(() => {
    if (!authSession?.authenticated || !authSession.user) return;
    if (authSession.user.theme_preference === 'light' || authSession.user.theme_preference === 'dark') {
      setThemeMode(authSession.user.theme_preference);
    }
    if (authSession.user.measurement_system === 'metric' || authSession.user.measurement_system === 'imperial') {
      setMeasurementSystem(authSession.user.measurement_system);
    }
  }, [authSession?.authenticated, authSession?.user?.id, authSession?.user?.theme_preference, authSession?.user?.measurement_system]);

  useEffect(() => {
    localStorage.setItem('tracker-theme', themeMode);
    // Mirror the theme onto the document root so overlays rendered outside the
    // .app subtree (toasts, confirm dialogs) inherit the same tokens.
    document.documentElement.setAttribute('data-theme', themeMode);
  }, [themeMode]);

  useEffect(() => {
    localStorage.setItem('tracker-measurement-system', measurementSystem);
  }, [measurementSystem]);

  return { themeMode, setThemeMode, measurementSystem, setMeasurementSystem };
}
