import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ActiveProfile, AuthSession, MeasurementSystem, ThemeMode } from '../types';

type UseSessionOptions = {
  setUiError: (message: string | null) => void;
  refreshProfiles: () => Promise<void>;
  refreshAdminData: () => Promise<void>;
  setProfileId: (id: ActiveProfile) => void;
  onLoggedOut: () => void;
};

/**
 * Auth session state plus the login/register/logout/account flows.
 * Cross-domain refreshes (profiles, admin data) are injected as callbacks so
 * this hook stays decoupled from the other data hooks.
 */
export function useSession({ setUiError, refreshProfiles, refreshAdminData, setProfileId, onLoggedOut }: UseSessionOptions) {
  const [authLoading, setAuthLoading] = useState(true);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [registerUsername, setRegisterUsername] = useState('');
  const [registerDisplayName, setRegisterDisplayName] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState('');
  const [accountUsername, setAccountUsername] = useState('');
  const [accountDisplayName, setAccountDisplayName] = useState('');
  const [accountDefaultProfileId, setAccountDefaultProfileId] = useState<string>('');
  const [accountPassword, setAccountPassword] = useState('');
  const [accountConfirmPassword, setAccountConfirmPassword] = useState('');

  useEffect(() => {
    let cancelled = false;
    api<AuthSession>('/api/auth/session')
      .then((session) => {
        if (cancelled) return;
        setAuthSession(session);
      })
      .catch(() => {
        if (cancelled) return;
        setAuthSession({ oidc_enabled: false, authenticated: false, user: null });
        setUiError('Unable to load authentication state.');
      })
      .finally(() => {
        if (cancelled) return;
        setAuthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setAccountUsername(authSession?.user?.username ?? '');
    setAccountDisplayName(authSession?.user?.display_name ?? '');
    setAccountDefaultProfileId(authSession?.user?.default_profile_id ? String(authSession.user.default_profile_id) : '');
    setAccountPassword('');
    setAccountConfirmPassword('');
  }, [authSession?.user?.id, authSession?.user?.username, authSession?.user?.display_name, authSession?.user?.default_profile_id]);

  const isAdmin = Boolean(authSession?.user?.is_admin);

  const refreshAuthSession = async () => {
    const session = await api<AuthSession>('/api/auth/session');
    setAuthSession(session);
    return session;
  };

  const handleLogout = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      await refreshAuthSession();
      onLoggedOut();
    } catch {
      setUiError('Could not sign out.');
    }
  };

  const handleLocalLogin = async () => {
    const username = loginUsername.trim().toLowerCase();
    const password = loginPassword;
    if (!username || !password || isAuthSubmitting) return;
    setUiError(null);
    setIsAuthSubmitting(true);
    try {
      await api('/api/auth/local/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      setShowLoginModal(false);
      setLoginPassword('');
      await refreshAuthSession();
      await refreshProfiles();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not sign in.';
      setUiError(message);
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const handleLocalRegister = async () => {
    const username = registerUsername.trim().toLowerCase();
    const displayName = registerDisplayName.trim();
    const password = registerPassword;
    const confirm = registerConfirmPassword;
    if (!username || !displayName || !password || isAuthSubmitting) return;
    if (password !== confirm) {
      setUiError('Password confirmation does not match.');
      return;
    }
    setUiError(null);
    setIsAuthSubmitting(true);
    try {
      await api('/api/auth/local/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, display_name: displayName, password }),
      });
      await refreshAuthSession();
      await refreshProfiles();
      setRegisterPassword('');
      setRegisterConfirmPassword('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not create user.';
      setUiError(message);
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  const saveAccount = async ({ themeMode, measurementSystem }: { themeMode: ThemeMode; measurementSystem: MeasurementSystem }) => {
    if (!authSession?.authenticated || isAuthSubmitting) return;
    const displayName = accountDisplayName.trim();
    if (!displayName) {
      setUiError('Display name is required.');
      return;
    }
    if (accountPassword && accountPassword !== accountConfirmPassword) {
      setUiError('Password confirmation does not match.');
      return;
    }

    const payload: Record<string, string> = {
      display_name: displayName,
      theme_preference: themeMode,
      measurement_system: measurementSystem,
      default_profile_id: accountDefaultProfileId,
    };
    if (!authSession.oidc_enabled) {
      payload.username = accountUsername.trim().toLowerCase();
      if (accountPassword) {
        payload.password = accountPassword;
      }
    }

    setUiError(null);
    setIsAuthSubmitting(true);
    try {
      await api('/api/auth/account', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setAccountPassword('');
      setAccountConfirmPassword('');
      await refreshAuthSession();
      if (accountDefaultProfileId) {
        setProfileId(Number(accountDefaultProfileId));
      }
      await refreshProfiles();
      if (isAdmin) {
        await refreshAdminData();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update account.';
      setUiError(message);
    } finally {
      setIsAuthSubmitting(false);
    }
  };

  return {
    authLoading,
    authSession,
    setAuthSession,
    isAdmin,
    refreshAuthSession,
    showLoginModal,
    setShowLoginModal,
    isAuthSubmitting,
    loginUsername,
    setLoginUsername,
    loginPassword,
    setLoginPassword,
    registerUsername,
    setRegisterUsername,
    registerDisplayName,
    setRegisterDisplayName,
    registerPassword,
    setRegisterPassword,
    registerConfirmPassword,
    setRegisterConfirmPassword,
    accountUsername,
    setAccountUsername,
    accountDisplayName,
    setAccountDisplayName,
    accountDefaultProfileId,
    setAccountDefaultProfileId,
    accountPassword,
    setAccountPassword,
    accountConfirmPassword,
    setAccountConfirmPassword,
    handleLogout,
    handleLocalLogin,
    handleLocalRegister,
    saveAccount,
  };
}
