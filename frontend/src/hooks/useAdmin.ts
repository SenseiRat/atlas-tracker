import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useConfirm } from '../components/ui/ConfirmDialog';
import type { ToastKind } from '../components/ui/toast';
import { normalizeHexColor, defaultProfileColor } from '../lib/colors';
import type { AdminProfile, AdminProfileEdit, AdminUser, AppSettings, AuthSession } from '../types';

type UseAdminOptions = {
  isAdmin: boolean;
  authSession: AuthSession | null;
  refreshAuthSession: () => Promise<AuthSession>;
  refreshProfiles: () => Promise<void>;
  nextSuggestedProfileColor: string;
  pushToast: (message: string, kind?: ToastKind) => void;
  setUiError: (message: string | null) => void;
};

/**
 * Admin-only state and flows: user management, server profile management, and
 * server settings (backend/auth configuration and migration).
 */
export function useAdmin({
  isAdmin,
  authSession,
  refreshAuthSession,
  refreshProfiles,
  nextSuggestedProfileColor,
  pushToast,
  setUiError,
}: UseAdminOptions) {
  const confirm = useConfirm();
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminProfiles, setAdminProfiles] = useState<AdminProfile[]>([]);
  const [adminSettings, setAdminSettings] = useState<AppSettings | null>(null);
  const [newAdminUserUsername, setNewAdminUserUsername] = useState('');
  const [newAdminUserDisplayName, setNewAdminUserDisplayName] = useState('');
  const [newAdminUserPassword, setNewAdminUserPassword] = useState('');
  const [newAdminUserIsAdmin, setNewAdminUserIsAdmin] = useState(false);
  const [newAdminProfileName, setNewAdminProfileName] = useState('');
  const [newAdminProfileOwnerId, setNewAdminProfileOwnerId] = useState('');
  const [newAdminProfileColor, setNewAdminProfileColor] = useState(defaultProfileColor);
  const [newAdminProfileHomeCountryCode, setNewAdminProfileHomeCountryCode] = useState('');
  const [newAdminProfilePublic, setNewAdminProfilePublic] = useState(false);
  const [adminPasswordReset, setAdminPasswordReset] = useState<Record<number, string>>({});
  const [adminUserEdits, setAdminUserEdits] = useState<Record<number, { username: string; display_name: string }>>({});
  const [adminProfileEdits, setAdminProfileEdits] = useState<Record<number, AdminProfileEdit>>({});
  const [isAdminMigrationSubmitting, setIsAdminMigrationSubmitting] = useState(false);

  useEffect(() => {
    const nextUsers = Object.fromEntries(
      adminUsers.map((user) => [
        user.id,
        {
          username: user.username ?? '',
          display_name: user.display_name ?? '',
        },
      ]),
    );
    setAdminUserEdits(nextUsers);
  }, [adminUsers]);

  useEffect(() => {
    const nextProfiles = Object.fromEntries(
      adminProfiles.map((profile) => [
        profile.id,
        {
          name: profile.name,
          owner_user_id: profile.owner_user_id ? String(profile.owner_user_id) : '',
          color: normalizeHexColor(profile.color),
          home_country_code: (profile.home_country_code ?? '').toUpperCase(),
          is_public: Boolean(profile.is_public),
        },
      ]),
    );
    setAdminProfileEdits(nextProfiles);
  }, [adminProfiles]);

  const refreshAdminData = async () => {
    if (!isAdmin) return;
    const [users, serverProfiles, settings] = await Promise.all([
      api<AdminUser[]>('/api/admin/users'),
      api<AdminProfile[]>('/api/admin/profiles'),
      api<AppSettings>('/api/admin/settings'),
    ]);
    setAdminUsers(users);
    setAdminProfiles(serverProfiles);
    setAdminSettings(settings);
  };

  useEffect(() => {
    if (!isAdmin) {
      setAdminUsers([]);
      setAdminProfiles([]);
      return;
    }
    refreshAdminData().catch(() => {
      setUiError('Unable to load admin settings.');
    });
  }, [isAdmin]);

  const handleAdminCreateUser = async () => {
    if (!isAdmin || !newAdminUserUsername.trim() || !newAdminUserDisplayName.trim() || !newAdminUserPassword) return;
    await api('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: newAdminUserUsername.trim().toLowerCase(),
        display_name: newAdminUserDisplayName.trim(),
        password: newAdminUserPassword,
        is_admin: newAdminUserIsAdmin,
      }),
    });
    setNewAdminUserUsername('');
    setNewAdminUserDisplayName('');
    setNewAdminUserPassword('');
    setNewAdminUserIsAdmin(false);
    await refreshAdminData();
  };

  const handleAdminUserRole = async (userId: number, role: 'admin' | 'user') => {
    await api(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    await refreshAdminData();
    await refreshAuthSession();
  };

  const handleAdminSaveUser = async (userId: number) => {
    const draft = adminUserEdits[userId];
    if (!draft) return;
    await api(`/api/admin/users/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: draft.username,
        display_name: draft.display_name,
      }),
    });
    await refreshAdminData();
    if (authSession?.user?.id === userId) {
      await refreshAuthSession();
    }
  };

  const handleAdminDeleteUser = async (userId: number) => {
    const ok = await confirm({
      title: 'Delete user',
      message: 'Delete this user and all of their profiles? This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await api(`/api/admin/users/${userId}`, { method: 'DELETE' });
    await refreshAdminData();
  };

  const handleAdminResetPassword = async (userId: number) => {
    const password = adminPasswordReset[userId]?.trim();
    if (!password) return;
    await api(`/api/admin/users/${userId}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    setAdminPasswordReset((prev) => ({ ...prev, [userId]: '' }));
  };

  const handleAdminDeleteProfile = async (serverProfileId: number) => {
    const ok = await confirm({
      title: 'Delete server profile',
      message: 'Delete this server profile?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    await api(`/api/admin/profiles/${serverProfileId}`, { method: 'DELETE' });
    await refreshAdminData();
    await refreshProfiles();
  };

  const handleAdminCreateProfile = async () => {
    if (!newAdminProfileName.trim() || !newAdminProfileOwnerId) return;
    await api('/api/admin/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newAdminProfileName.trim(),
        owner_user_id: Number(newAdminProfileOwnerId),
        color: normalizeHexColor(newAdminProfileColor),
        home_country_code: newAdminProfileHomeCountryCode || null,
        is_public: newAdminProfilePublic,
      }),
    });
    setNewAdminProfileName('');
    setNewAdminProfileOwnerId('');
    setNewAdminProfileColor(nextSuggestedProfileColor);
    setNewAdminProfileHomeCountryCode('');
    setNewAdminProfilePublic(false);
    await refreshAdminData();
    await refreshProfiles();
  };

  const handleAdminSaveProfile = async (profileIdToSave: number) => {
    const draft = adminProfileEdits[profileIdToSave];
    if (!draft || !draft.name.trim()) return;
    await api(`/api/admin/profiles/${profileIdToSave}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: draft.name.trim(),
        color: draft.color,
        home_country_code: draft.home_country_code || null,
        is_public: draft.is_public,
        owner_user_id: draft.owner_user_id ? Number(draft.owner_user_id) : null,
      }),
    });
    await refreshAdminData();
    await refreshProfiles();
  };

  const handleAdminSaveSettings = async () => {
    if (!adminSettings) return;
    const updated = await api<AppSettings>('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(adminSettings),
    });
    setAdminSettings(updated);
  };

  const handleAdminMigrateDatabase = async () => {
    if (!adminSettings || isAdminMigrationSubmitting) return;
    const ok = await confirm({
      title: 'Migrate database',
      message: `Migrate all application data into ${adminSettings.preferred_db_backend}? This overwrites data in the target database.`,
      confirmLabel: 'Migrate',
      destructive: true,
    });
    if (!ok) return;
    setIsAdminMigrationSubmitting(true);
    try {
      const updated = await api<AppSettings & { migration_summary?: Record<string, number | string> }>('/api/admin/settings/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(adminSettings),
      });
      setAdminSettings(updated);
      await refreshAuthSession();
      const summary = updated.migration_summary;
      if (summary) {
        pushToast(
          `Migration complete to ${summary.target_backend}. Copied ${summary.users} users, ${summary.profiles} profiles, ${summary.visits} visits, and ${summary.trip_logs} trip logs. Restart the server to switch backends.`,
          'success',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not migrate database.';
      setUiError(message);
    } finally {
      setIsAdminMigrationSubmitting(false);
    }
  };

  return {
    adminUsers,
    adminProfiles,
    adminSettings,
    setAdminSettings,
    newAdminUserUsername,
    setNewAdminUserUsername,
    newAdminUserDisplayName,
    setNewAdminUserDisplayName,
    newAdminUserPassword,
    setNewAdminUserPassword,
    newAdminUserIsAdmin,
    setNewAdminUserIsAdmin,
    newAdminProfileName,
    setNewAdminProfileName,
    newAdminProfileOwnerId,
    setNewAdminProfileOwnerId,
    newAdminProfileColor,
    setNewAdminProfileColor,
    newAdminProfileHomeCountryCode,
    setNewAdminProfileHomeCountryCode,
    newAdminProfilePublic,
    setNewAdminProfilePublic,
    adminPasswordReset,
    setAdminPasswordReset,
    adminUserEdits,
    setAdminUserEdits,
    adminProfileEdits,
    setAdminProfileEdits,
    isAdminMigrationSubmitting,
    refreshAdminData,
    handleAdminCreateUser,
    handleAdminUserRole,
    handleAdminSaveUser,
    handleAdminDeleteUser,
    handleAdminResetPassword,
    handleAdminDeleteProfile,
    handleAdminCreateProfile,
    handleAdminSaveProfile,
    handleAdminSaveSettings,
    handleAdminMigrateDatabase,
  };
}
