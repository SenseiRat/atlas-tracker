import { Modal } from './ui/Modal';
import { ProfileColorField } from './ProfileColorField';
import type { useAdmin } from '../hooks/useAdmin';
import type { AuthSession, MapLabelLanguage, MeasurementSystem, Place, Profile, ThemeMode } from '../types';

type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
  authSession: AuthSession | null;
  isAuthSubmitting: boolean;
  accountPassword: string;
  setAccountPassword: (value: string) => void;
  accountConfirmPassword: string;
  setAccountConfirmPassword: (value: string) => void;
  accountDisplayName: string;
  setAccountDisplayName: (value: string) => void;
  accountDefaultProfileId: string;
  setAccountDefaultProfileId: (value: string) => void;
  themeMode: ThemeMode;
  setThemeMode: (value: ThemeMode) => void;
  measurementSystem: MeasurementSystem;
  setMeasurementSystem: (value: MeasurementSystem) => void;
  mapLabelLanguage: MapLabelLanguage;
  setMapLabelLanguage: (value: MapLabelLanguage) => void;
  ownedProfiles: Profile[];
  publicProfiles: Profile[];
  handleAccountSave: () => void;
  handleLogout: () => void;
  onOpenLogin: () => void;
  isAdmin: boolean;
  admin: ReturnType<typeof useAdmin>;
  countries: Place[];
};

export function SettingsModal({
  open,
  onClose,
  authSession,
  isAuthSubmitting,
  accountPassword,
  setAccountPassword,
  accountConfirmPassword,
  setAccountConfirmPassword,
  accountDisplayName,
  setAccountDisplayName,
  accountDefaultProfileId,
  setAccountDefaultProfileId,
  themeMode,
  setThemeMode,
  measurementSystem,
  setMeasurementSystem,
  mapLabelLanguage,
  setMapLabelLanguage,
  ownedProfiles,
  publicProfiles,
  handleAccountSave,
  handleLogout,
  onOpenLogin,
  isAdmin,
  admin,
  countries,
}: SettingsModalProps) {
  const {
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
  } = admin;

  const settingsBody = (
    <>
      <details className="settings-section" open>
        <summary>
          <div>
            <strong>Authentication</strong>
            <span>Password and sign-in controls.</span>
          </div>
        </summary>
        <div className="settings-section__content trip-form">
          <div className="settings-note">
            <strong>Status</strong>
            <span>
              {authSession?.authenticated
                ? `Signed in as ${authSession.user?.display_name || authSession.user?.username || authSession.user?.email || 'user'}`
                : 'Not signed in'}
            </span>
          </div>
          <div className="settings-note">
            <strong>Mode</strong>
            <span>{authSession?.oidc_enabled ? 'OIDC' : 'Local username and password'}</span>
          </div>
          {!authSession?.authenticated && authSession?.has_local_users && !authSession?.oidc_enabled && (
            <button type="button" className="accent-button" onClick={onOpenLogin}>
              Open login
            </button>
          )}
          {!authSession?.authenticated && authSession?.oidc_enabled && (
            <button type="button" className="accent-button" onClick={() => (window.location.href = '/api/auth/login')}>
              Sign in with OIDC
            </button>
          )}
          {authSession?.authenticated ? (
            <>
              {!authSession.oidc_enabled && (
                <div className="settings-subsection">
                  <h3>Password</h3>
                  <label>
                    New password
                    <input type="password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} />
                  </label>
                  <label>
                    Confirm password
                    <input
                      type="password"
                      value={accountConfirmPassword}
                      onChange={(event) => setAccountConfirmPassword(event.target.value)}
                    />
                  </label>
                </div>
              )}
              <div className="settings-actions">
                <button type="button" className="accent-button" onClick={handleAccountSave} disabled={isAuthSubmitting}>
                  {isAuthSubmitting ? 'Saving...' : 'Save authentication settings'}
                </button>
                <button type="button" onClick={handleLogout}>
                  Log out
                </button>
              </div>
            </>
          ) : (
            <p>Sign in to manage your password.</p>
          )}
        </div>
      </details>

      <details className="settings-section" open>
        <summary>
          <div>
            <strong>Profile</strong>
            <span>Theme, display name, default map profile, and measurement preference.</span>
          </div>
        </summary>
        <div className="settings-section__content trip-form">
          {authSession?.authenticated ? (
            <>
              <div className="settings-subsection">
                <h3>Appearance</h3>
                <label>
                  Theme
                  <select value={themeMode} onChange={(event) => setThemeMode(event.target.value as ThemeMode)}>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                  </select>
                </label>
                <label>
                  Measurements
                  <select
                    value={measurementSystem}
                    onChange={(event) => setMeasurementSystem(event.target.value as MeasurementSystem)}
                  >
                    <option value="imperial">Imperial</option>
                    <option value="metric">Metric</option>
                  </select>
                </label>
                <label>
                  Map labels
                  <select
                    value={mapLabelLanguage}
                    onChange={(event) => setMapLabelLanguage(event.target.value as MapLabelLanguage)}
                  >
                    <option value="local">Local place names</option>
                    <option value="english">English place names</option>
                  </select>
                </label>
              </div>
              <div className="settings-subsection">
                <h3>Account</h3>
                <label>
                  Display name
                  <input value={accountDisplayName} onChange={(event) => setAccountDisplayName(event.target.value)} />
                </label>
                <label>
                  Default map profile
                  <select value={accountDefaultProfileId} onChange={(event) => setAccountDefaultProfileId(event.target.value)}>
                    <option value="">No default</option>
                    {ownedProfiles.map((profile) => (
                      <option key={`default-owned-${profile.id}`} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                    {publicProfiles.map((profile) => (
                      <option key={`default-public-${profile.id}`} value={profile.id}>
                        {profile.name} (Public)
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button type="button" className="accent-button" onClick={handleAccountSave} disabled={isAuthSubmitting}>
                {isAuthSubmitting ? 'Saving...' : 'Save profile settings'}
              </button>
            </>
          ) : (
            <p>Sign in to manage your profile settings.</p>
          )}
        </div>
      </details>

      {isAdmin && adminSettings && (
        <details className="settings-section">
          <summary>
            <div>
              <strong>Server Backend</strong>
              <span>Choose SQLite or Postgres and migrate data between them.</span>
            </div>
          </summary>
          <div className="settings-section__content trip-form">
            <div className="settings-subsection">
              <h3>Backend target</h3>
              <label>
                Backend
                <select
                  value={adminSettings.preferred_db_backend}
                  onChange={(event) =>
                    setAdminSettings((prev) =>
                      prev ? { ...prev, preferred_db_backend: event.target.value as 'sqlite' | 'postgres' } : prev,
                    )
                  }
                >
                  <option value="sqlite">SQLite</option>
                  <option value="postgres">Postgres</option>
                </select>
              </label>
              <div className="settings-note">
                <strong>Current backend</strong>
                <span>{adminSettings.configured_db_backend}</span>
              </div>
            </div>
            <div className="settings-subsection">
              <h3>Connection settings</h3>
              <label>
                SQLite path
                <input
                  value={adminSettings.sqlite_db_path ?? ''}
                  onChange={(event) =>
                    setAdminSettings((prev) => (prev ? { ...prev, sqlite_db_path: event.target.value } : prev))
                  }
                />
              </label>
              <div className="settings-grid">
                <label>
                  DB host
                  <input
                    value={adminSettings.db_host ?? ''}
                    onChange={(event) => setAdminSettings((prev) => (prev ? { ...prev, db_host: event.target.value } : prev))}
                  />
                </label>
                <label>
                  DB port
                  <input
                    value={adminSettings.db_port ?? ''}
                    onChange={(event) => setAdminSettings((prev) => (prev ? { ...prev, db_port: event.target.value } : prev))}
                  />
                </label>
                <label>
                  DB name
                  <input
                    value={adminSettings.db_name ?? ''}
                    onChange={(event) => setAdminSettings((prev) => (prev ? { ...prev, db_name: event.target.value } : prev))}
                  />
                </label>
                <label>
                  DB user
                  <input
                    value={adminSettings.db_user ?? ''}
                    onChange={(event) => setAdminSettings((prev) => (prev ? { ...prev, db_user: event.target.value } : prev))}
                  />
                </label>
                <label>
                  DB password
                  <input
                    type="password"
                    value={adminSettings.db_password ?? ''}
                    onChange={(event) => setAdminSettings((prev) => (prev ? { ...prev, db_password: event.target.value } : prev))}
                  />
                </label>
              </div>
              <div className="settings-actions">
                <button type="button" onClick={handleAdminSaveSettings}>Save backend settings</button>
                <button
                  type="button"
                  className="accent-button"
                  onClick={handleAdminMigrateDatabase}
                  disabled={isAdminMigrationSubmitting}
                >
                  {isAdminMigrationSubmitting ? 'Migrating...' : `Migrate to ${adminSettings.preferred_db_backend}`}
                </button>
              </div>
            </div>
          </div>
        </details>
      )}

      {isAdmin && adminSettings && (
        <details className="settings-section">
          <summary>
            <div>
              <strong>Authentication Configuration</strong>
              <span>Choose username/password or OIDC for the server.</span>
            </div>
          </summary>
          <div className="settings-section__content trip-form">
            <div className="settings-subsection">
              <h3>Authentication mode</h3>
              <label>
                Mode
                <select
                  value={adminSettings.auth_mode}
                  onChange={(event) =>
                    setAdminSettings((prev) => (prev ? { ...prev, auth_mode: event.target.value } : prev))
                  }
                >
                  <option value="local">Username / password</option>
                  <option value="oidc">OIDC</option>
                </select>
              </label>
              <label>
                OIDC issuer
                <input
                  value={adminSettings.oidc_issuer ?? ''}
                  onChange={(event) =>
                    setAdminSettings((prev) => (prev ? { ...prev, oidc_issuer: event.target.value } : prev))
                  }
                />
              </label>
              <label>
                OIDC client id
                <input
                  value={adminSettings.oidc_client_id ?? ''}
                  onChange={(event) =>
                    setAdminSettings((prev) => (prev ? { ...prev, oidc_client_id: event.target.value } : prev))
                  }
                />
              </label>
              <label>
                OIDC client secret
                <input
                  type="password"
                  value={adminSettings.oidc_client_secret ?? ''}
                  onChange={(event) =>
                    setAdminSettings((prev) => (prev ? { ...prev, oidc_client_secret: event.target.value } : prev))
                  }
                />
              </label>
              <button type="button" className="accent-button" onClick={handleAdminSaveSettings}>
                Save authentication configuration
              </button>
            </div>
          </div>
        </details>
      )}

      {isAdmin && (
        <details className="settings-section">
          <summary>
            <div>
              <strong>Global Profile Management</strong>
              <span>Add, edit name/color, delete, and control profile visibility.</span>
            </div>
          </summary>
          <div className="settings-section__content trip-form">
            <div className="settings-subsection">
              <h3>Add profile</h3>
              <label>
                Profile name
                <input value={newAdminProfileName} onChange={(event) => setNewAdminProfileName(event.target.value)} />
              </label>
              <label>
                Owner
                <select value={newAdminProfileOwnerId} onChange={(event) => setNewAdminProfileOwnerId(event.target.value)}>
                  <option value="">Select user</option>
                  {adminUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.display_name || user.username || `User ${user.id}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Home country
                <select value={newAdminProfileHomeCountryCode} onChange={(event) => setNewAdminProfileHomeCountryCode(event.target.value)}>
                  <option value="">None</option>
                  {countries.map((country) => (
                    <option key={`admin-new-home-${country.id}`} value={(country.country_code ?? '').toUpperCase()}>
                      {country.name}
                    </option>
                  ))}
                </select>
              </label>
              <ProfileColorField value={newAdminProfileColor} onChange={setNewAdminProfileColor} />
              <label className="toggle">
                <input type="checkbox" checked={newAdminProfilePublic} onChange={(event) => setNewAdminProfilePublic(event.target.checked)} />
                Public profile
              </label>
              <button type="button" className="accent-button" onClick={handleAdminCreateProfile}>Add profile</button>
            </div>
            <ul className="trip-list">
              {adminProfiles.map((profile) => (
                <li key={profile.id} className="trip-card admin-card">
                  <div className="trip-main">
                    <strong>{profile.name}</strong>
                    <span>{profile.owner_label || 'Unknown owner'}</span>
                  </div>
                  <div className="admin-actions">
                    <label>
                      Name
                      <input
                        value={adminProfileEdits[profile.id]?.name ?? ''}
                        onChange={(event) =>
                          setAdminProfileEdits((prev) => ({
                            ...prev,
                            [profile.id]: {
                              ...(prev[profile.id] ?? {
                                name: profile.name,
                                owner_user_id: profile.owner_user_id ? String(profile.owner_user_id) : '',
                                color: profile.color,
                                home_country_code: (profile.home_country_code ?? '').toUpperCase(),
                                is_public: profile.is_public,
                              }),
                              name: event.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      Owner
                      <select
                        value={adminProfileEdits[profile.id]?.owner_user_id ?? ''}
                        onChange={(event) =>
                          setAdminProfileEdits((prev) => ({
                            ...prev,
                            [profile.id]: {
                              ...(prev[profile.id] ?? {
                                name: profile.name,
                                owner_user_id: profile.owner_user_id ? String(profile.owner_user_id) : '',
                                color: profile.color,
                                home_country_code: (profile.home_country_code ?? '').toUpperCase(),
                                is_public: profile.is_public,
                              }),
                              owner_user_id: event.target.value,
                            },
                          }))
                        }
                      >
                        <option value="">Unowned</option>
                        {adminUsers.map((user) => (
                          <option key={`owner-${profile.id}-${user.id}`} value={user.id}>
                            {user.display_name || user.username || `User ${user.id}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Home country
                      <select
                        value={adminProfileEdits[profile.id]?.home_country_code ?? ''}
                        onChange={(event) =>
                          setAdminProfileEdits((prev) => ({
                            ...prev,
                            [profile.id]: {
                              ...(prev[profile.id] ?? {
                                name: profile.name,
                                owner_user_id: profile.owner_user_id ? String(profile.owner_user_id) : '',
                                color: profile.color,
                                home_country_code: (profile.home_country_code ?? '').toUpperCase(),
                                is_public: profile.is_public,
                              }),
                              home_country_code: event.target.value,
                            },
                          }))
                        }
                      >
                        <option value="">None</option>
                        {countries.map((country) => (
                          <option key={`admin-home-${profile.id}-${country.id}`} value={(country.country_code ?? '').toUpperCase()}>
                            {country.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Color
                      <input
                        type="color"
                        value={adminProfileEdits[profile.id]?.color ?? profile.color}
                        onChange={(event) =>
                          setAdminProfileEdits((prev) => ({
                            ...prev,
                            [profile.id]: {
                              ...(prev[profile.id] ?? {
                                name: profile.name,
                                owner_user_id: profile.owner_user_id ? String(profile.owner_user_id) : '',
                                color: profile.color,
                                home_country_code: (profile.home_country_code ?? '').toUpperCase(),
                                is_public: profile.is_public,
                              }),
                              color: event.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="toggle">
                      <input
                        type="checkbox"
                        checked={adminProfileEdits[profile.id]?.is_public ?? profile.is_public}
                        onChange={(event) =>
                          setAdminProfileEdits((prev) => ({
                            ...prev,
                            [profile.id]: {
                              ...(prev[profile.id] ?? {
                                name: profile.name,
                                owner_user_id: profile.owner_user_id ? String(profile.owner_user_id) : '',
                                color: profile.color,
                                home_country_code: (profile.home_country_code ?? '').toUpperCase(),
                                is_public: profile.is_public,
                              }),
                              is_public: event.target.checked,
                            },
                          }))
                        }
                      />
                      Public
                    </label>
                    <button type="button" onClick={() => handleAdminSaveProfile(profile.id)}>Save</button>
                    <button
                      type="button"
                      onClick={() =>
                        setAdminProfileEdits((prev) => ({
                          ...prev,
                          [profile.id]: {
                            ...(prev[profile.id] ?? {
                              name: profile.name,
                              owner_user_id: profile.owner_user_id ? String(profile.owner_user_id) : '',
                              color: profile.color,
                              home_country_code: (profile.home_country_code ?? '').toUpperCase(),
                              is_public: profile.is_public,
                            }),
                            is_public: !(prev[profile.id]?.is_public ?? profile.is_public),
                          },
                        }))
                      }
                    >
                      {(adminProfileEdits[profile.id]?.is_public ?? profile.is_public) ? 'Make private' : 'Make public'}
                    </button>
                    <button type="button" onClick={() => handleAdminDeleteProfile(profile.id)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}

      {isAdmin && (
        <details className="settings-section">
          <summary>
            <div>
              <strong>Global User Management</strong>
              <span>Add users, edit identity details, promote admins, and reset passwords.</span>
            </div>
          </summary>
          <div className="settings-section__content trip-form">
            <div className="settings-subsection">
              <h3>Add user</h3>
              <label>
                Username
                <input value={newAdminUserUsername} onChange={(event) => setNewAdminUserUsername(event.target.value)} />
              </label>
              <label>
                Display name
                <input value={newAdminUserDisplayName} onChange={(event) => setNewAdminUserDisplayName(event.target.value)} />
              </label>
              <label>
                Password
                <input type="password" value={newAdminUserPassword} onChange={(event) => setNewAdminUserPassword(event.target.value)} />
              </label>
              <label className="toggle">
                <input type="checkbox" checked={newAdminUserIsAdmin} onChange={(event) => setNewAdminUserIsAdmin(event.target.checked)} />
                Create as admin
              </label>
              <button type="button" className="accent-button" onClick={handleAdminCreateUser}>Add user</button>
            </div>
            <ul className="trip-list">
              {adminUsers.map((user) => (
                <li key={user.id} className="trip-card admin-card">
                  <div className="trip-main">
                    <strong>{user.display_name || user.username || `User ${user.id}`}</strong>
                    <span>@{user.username || 'n/a'} · {user.role}</span>
                  </div>
                  <div className="admin-actions">
                    <label>
                      Username
                      <input
                        value={adminUserEdits[user.id]?.username ?? ''}
                        onChange={(event) =>
                          setAdminUserEdits((prev) => ({
                            ...prev,
                            [user.id]: {
                              username: event.target.value,
                              display_name: prev[user.id]?.display_name ?? user.display_name ?? '',
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      Display name
                      <input
                        value={adminUserEdits[user.id]?.display_name ?? ''}
                        onChange={(event) =>
                          setAdminUserEdits((prev) => ({
                            ...prev,
                            [user.id]: {
                              username: prev[user.id]?.username ?? user.username ?? '',
                              display_name: event.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                    <button type="button" onClick={() => handleAdminSaveUser(user.id)}>Save details</button>
                    <button type="button" onClick={() => handleAdminUserRole(user.id, user.is_admin ? 'user' : 'admin')}>
                      {user.is_admin ? 'Demote' : 'Promote'}
                    </button>
                    <input
                      type="password"
                      placeholder="New password"
                      value={adminPasswordReset[user.id] ?? ''}
                      onChange={(event) => setAdminPasswordReset((prev) => ({ ...prev, [user.id]: event.target.value }))}
                    />
                    <button type="button" onClick={() => handleAdminResetPassword(user.id)}>Reset password</button>
                    <button type="button" onClick={() => handleAdminDeleteUser(user.id)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </>
  );

  return (
    <Modal open={open} onClose={onClose} className="first-run-card settings-card" ariaLabel="Settings">
      <div className="settings-card__header">
        <div>
          <h2>Settings</h2>
          <p>Account, application, and server configuration.</p>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="settings-card__body">{settingsBody}</div>
    </Modal>
  );
}
