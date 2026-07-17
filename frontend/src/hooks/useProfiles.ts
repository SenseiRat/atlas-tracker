import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { createProfileVisuals, defaultProfileColor, normalizeHexColor, profilePalette } from '../lib/colors';
import type { ActiveProfile, AuthSession, Profile, ThemeMode } from '../types';

type UseProfilesOptions = {
  authSession: AuthSession | null;
  enabled: boolean;
  themeMode: ThemeMode;
  setUiError: (message: string | null) => void;
};

/**
 * Profile list and active-profile selection, plus the create/edit/delete
 * profile flows and the per-profile color visuals used by the map.
 */
export function useProfiles({ authSession, enabled, themeMode, setUiError }: UseProfilesOptions) {
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<ActiveProfile>(null);
  const [isProfileSubmitting, setIsProfileSubmitting] = useState(false);
  const [showCreateProfileModal, setShowCreateProfileModal] = useState(false);
  const [showEditProfileModal, setShowEditProfileModal] = useState(false);
  const [showFirstProfilePrompt, setShowFirstProfilePrompt] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileColor, setNewProfileColor] = useState(defaultProfileColor);
  const [newProfileHomeCountryCode, setNewProfileHomeCountryCode] = useState('');
  const [newProfilePublic, setNewProfilePublic] = useState(false);
  const [editProfileName, setEditProfileName] = useState('');
  const [selectedProfileColor, setSelectedProfileColor] = useState(defaultProfileColor);
  const [selectedProfileHomeCountryCode, setSelectedProfileHomeCountryCode] = useState('');
  const [selectedProfilePublic, setSelectedProfilePublic] = useState(false);

  const nextSuggestedProfileColor = useMemo(() => {
    const used = new Set(profiles.map((profile) => normalizeHexColor(profile.color)));
    return profilePalette.find((color) => !used.has(color)) ?? profilePalette[profiles.length % profilePalette.length];
  }, [profiles]);

  const profileColorById = useMemo(() => {
    const map = new Map<number, string>();
    profiles.forEach((profile, index) =>
      map.set(profile.id, normalizeHexColor(profile.color, profilePalette[index % profilePalette.length])),
    );
    return map;
  }, [profiles]);

  const profileVisualsById = useMemo(() => {
    const map = new Map<number, ReturnType<typeof createProfileVisuals>>();
    profileColorById.forEach((color, id) => {
      map.set(id, createProfileVisuals(color, themeMode));
    });
    return map;
  }, [profileColorById, themeMode]);

  useEffect(() => {
    if (typeof profileId !== 'number') {
      setSelectedProfileColor(defaultProfileColor);
      setSelectedProfileHomeCountryCode('');
      setSelectedProfilePublic(false);
      return;
    }
    const active = profiles.find((profile) => profile.id === profileId);
    setEditProfileName(active?.name ?? '');
    setSelectedProfileColor(normalizeHexColor(active?.color));
    setSelectedProfileHomeCountryCode((active?.home_country_code ?? '').toUpperCase());
    setSelectedProfilePublic(Boolean(active?.is_public));
  }, [profiles, profileId]);

  useEffect(() => {
    if (showFirstProfilePrompt) {
      setNewProfileColor(nextSuggestedProfileColor);
    }
  }, [showFirstProfilePrompt, nextSuggestedProfileColor]);

  const selectedProfile = useMemo(
    () => (typeof profileId === 'number' ? profiles.find((profile) => profile.id === profileId) ?? null : null),
    [profiles, profileId],
  );
  const canEditSelectedProfile = Boolean(authSession?.authenticated && selectedProfile?.is_owned);
  const ownedProfiles = useMemo(() => profiles.filter((profile) => profile.is_owned), [profiles]);
  const publicProfiles = useMemo(() => profiles.filter((profile) => !profile.is_owned && profile.is_public), [profiles]);

  const refreshProfiles = async () => {
    const data = await api<Profile[]>('/api/profiles');
    setProfiles(data);
    const ownedProfiles = data.filter((profile) => profile.is_owned);
    const publicProfiles = data.filter((profile) => !profile.is_owned && profile.is_public);
    const preferredFromAccount =
      typeof authSession?.user?.default_profile_id === 'number'
        ? data.find((profile) => profile.id === authSession.user?.default_profile_id) ?? null
        : null;
    const preferred = preferredFromAccount ?? (authSession?.authenticated ? ownedProfiles[0] ?? publicProfiles[0] : publicProfiles[0]);

    const hasCurrentSelection =
      profileId === null ||
      (typeof profileId === 'number' && data.some((profile) => profile.id === profileId));
    if (!hasCurrentSelection) {
      setProfileId(preferred?.id ?? null);
    }
    setShowFirstProfilePrompt(Boolean(authSession?.authenticated) && ownedProfiles.length === 0);
  };

  useEffect(() => {
    if (!enabled) return;
    refreshProfiles().catch(() => {
      setProfiles([]);
      setProfileId(null);
      setUiError('Unable to load profiles.');
    });
  }, [enabled, authSession?.authenticated]);

  const openCreateProfileModal = () => {
    setNewProfileName('');
    setNewProfilePublic(false);
    setNewProfileColor(nextSuggestedProfileColor);
    setNewProfileHomeCountryCode('');
    setShowCreateProfileModal(true);
  };

  const handleCreateProfile = async (name?: string) => {
    if (!authSession?.authenticated) return;
    const candidate = (name ?? newProfileName).trim();
    if (!candidate || isProfileSubmitting) return;

    setIsProfileSubmitting(true);
    try {
      const profile = await api<Profile>('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: candidate,
          color: normalizeHexColor(newProfileColor),
          home_country_code: newProfileHomeCountryCode || null,
          is_public: Boolean(newProfilePublic),
        }),
      });

      setNewProfileName('');
      setNewProfileColor(nextSuggestedProfileColor);
      setNewProfileHomeCountryCode('');
      setNewProfilePublic(false);
      setShowCreateProfileModal(false);
      await refreshProfiles();
      setProfileId(profile.id);
      setShowFirstProfilePrompt(false);
    } finally {
      setIsProfileSubmitting(false);
    }
  };

  const handleDeleteProfile = async () => {
    if (typeof profileId !== 'number' || !canEditSelectedProfile) return;
    const ok = await confirm({
      title: 'Delete profile',
      message: 'Delete this profile and all its visits and trip logs? This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;

    await api(`/api/profiles/${profileId}`, { method: 'DELETE' });
    await refreshProfiles();
  };

  const handleEditProfile = async () => {
    if (typeof profileId !== 'number' || !canEditSelectedProfile) return;
    setShowEditProfileModal(true);
  };

  const handleSaveProfileEdits = async () => {
    if (typeof profileId !== 'number' || !canEditSelectedProfile || isProfileSubmitting) return;
    const currentName = editProfileName.trim();
    if (!currentName) return;
    setIsProfileSubmitting(true);
    try {
      await api(`/api/profiles/${profileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: currentName,
          color: normalizeHexColor(selectedProfileColor),
          home_country_code: selectedProfileHomeCountryCode || null,
          is_public: selectedProfilePublic,
        }),
      });
      setShowEditProfileModal(false);
      await refreshProfiles();
    } finally {
      setIsProfileSubmitting(false);
    }
  };

  return {
    profiles,
    setProfiles,
    profileId,
    setProfileId,
    isProfileSubmitting,
    showCreateProfileModal,
    setShowCreateProfileModal,
    showEditProfileModal,
    setShowEditProfileModal,
    showFirstProfilePrompt,
    newProfileName,
    setNewProfileName,
    newProfileColor,
    setNewProfileColor,
    newProfileHomeCountryCode,
    setNewProfileHomeCountryCode,
    newProfilePublic,
    setNewProfilePublic,
    editProfileName,
    setEditProfileName,
    selectedProfileColor,
    setSelectedProfileColor,
    selectedProfileHomeCountryCode,
    setSelectedProfileHomeCountryCode,
    selectedProfilePublic,
    setSelectedProfilePublic,
    nextSuggestedProfileColor,
    profileColorById,
    profileVisualsById,
    selectedProfile,
    canEditSelectedProfile,
    ownedProfiles,
    publicProfiles,
    refreshProfiles,
    openCreateProfileModal,
    handleCreateProfile,
    handleDeleteProfile,
    handleEditProfile,
    handleSaveProfileEdits,
  };
}
