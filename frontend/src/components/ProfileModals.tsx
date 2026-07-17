import { Modal } from './ui/Modal';
import { ProfileColorField } from './ProfileColorField';
import type { useProfiles } from '../hooks/useProfiles';
import type { Place } from '../types';

type ProfilesApi = ReturnType<typeof useProfiles>;

/**
 * First-profile prompt plus the create-profile and edit-profile modals.
 */
export function ProfileModals({ profilesApi, countries }: { profilesApi: ProfilesApi; countries: Place[] }) {
  const {
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
    selectedProfile,
    handleCreateProfile,
    handleSaveProfileEdits,
  } = profilesApi;

  return (
    <>
      {showFirstProfilePrompt && (
        <div className="first-run-modal">
          <div className="first-run-card">
            <h2>Create your first profile</h2>
            <p>Profiles are private by default. Share only if you opt in.</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreateProfile();
              }}
            >
              <input
                type="text"
                placeholder="Profile name"
                value={newProfileName}
                onChange={(event) => setNewProfileName(event.target.value)}
              />
              <select value={newProfileHomeCountryCode} onChange={(event) => setNewProfileHomeCountryCode(event.target.value)}>
                <option value="">Home country</option>
                {countries.map((country) => (
                  <option key={`first-profile-home-${country.id}`} value={(country.country_code ?? '').toUpperCase()}>
                    {country.name}
                  </option>
                ))}
              </select>
              <ProfileColorField value={newProfileColor} onChange={setNewProfileColor} />
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={newProfilePublic}
                  onChange={(event) => setNewProfilePublic(event.target.checked)}
                />
                Share this profile publicly
              </label>
              <button type="submit" disabled={isProfileSubmitting}>
                {isProfileSubmitting ? 'Creating...' : 'Create profile'}
              </button>
            </form>
          </div>
        </div>
      )}

      <Modal
        open={showCreateProfileModal}
        onClose={() => setShowCreateProfileModal(false)}
        className="first-run-card"
        ariaLabel="Create profile"
      >
        <h2>Create profile</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreateProfile();
          }}
        >
          <input
            type="text"
            placeholder="Profile name"
            value={newProfileName}
            onChange={(event) => setNewProfileName(event.target.value)}
          />
          <select value={newProfileHomeCountryCode} onChange={(event) => setNewProfileHomeCountryCode(event.target.value)}>
            <option value="">Home country</option>
            {countries.map((country) => (
              <option key={`new-profile-home-${country.id}`} value={(country.country_code ?? '').toUpperCase()}>
                {country.name}
              </option>
            ))}
          </select>
          <ProfileColorField value={newProfileColor} onChange={setNewProfileColor} />
          <label className="toggle">
            <input
              type="checkbox"
              checked={newProfilePublic}
              onChange={(event) => setNewProfilePublic(event.target.checked)}
            />
            Share this profile publicly
          </label>
          <div className="modal-actions">
            <button type="submit" disabled={isProfileSubmitting}>
              {isProfileSubmitting ? 'Creating...' : 'Create'}
            </button>
            <button type="button" onClick={() => setShowCreateProfileModal(false)} disabled={isProfileSubmitting}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={showEditProfileModal && Boolean(selectedProfile)}
        onClose={() => setShowEditProfileModal(false)}
        className="first-run-card"
        ariaLabel="Edit profile"
      >
        <h2>Edit profile</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSaveProfileEdits();
          }}
        >
          <input
            type="text"
            placeholder="Profile name"
            value={editProfileName}
            onChange={(event) => setEditProfileName(event.target.value)}
          />
          <select value={selectedProfileHomeCountryCode} onChange={(event) => setSelectedProfileHomeCountryCode(event.target.value)}>
            <option value="">Home country</option>
            {countries.map((country) => (
              <option key={`edit-profile-home-${country.id}`} value={(country.country_code ?? '').toUpperCase()}>
                {country.name}
              </option>
            ))}
          </select>
          <ProfileColorField value={selectedProfileColor} onChange={setSelectedProfileColor} />
          <label className="toggle">
            <input
              type="checkbox"
              checked={selectedProfilePublic}
              onChange={(event) => setSelectedProfilePublic(event.target.checked)}
            />
            Share this profile publicly
          </label>
          <div className="modal-actions">
            <button type="submit" disabled={isProfileSubmitting}>
              {isProfileSubmitting ? 'Saving...' : 'Save'}
            </button>
            <button type="button" onClick={() => setShowEditProfileModal(false)} disabled={isProfileSubmitting}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
