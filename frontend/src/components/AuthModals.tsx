import { Modal } from './ui/Modal';
import type { useSession } from '../hooks/useSession';

type SessionApi = ReturnType<typeof useSession>;

/** First-run "create your first user" screen, shown when no users exist yet. */
export function FirstRunSetup({ session }: { session: SessionApi }) {
  const {
    authSession,
    isAuthSubmitting,
    registerUsername,
    setRegisterUsername,
    registerDisplayName,
    setRegisterDisplayName,
    registerPassword,
    setRegisterPassword,
    registerConfirmPassword,
    setRegisterConfirmPassword,
    handleLocalRegister,
  } = session;

  return (
    <>
      {!authSession?.authenticated && !authSession?.oidc_enabled && !authSession?.has_local_users && (
        <div className="first-run-modal">
          <div className="first-run-card">
            <h2>Create your first user</h2>
            <p>Users are required. Set up an account to unlock profile editing and tracking.</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleLocalRegister();
              }}
            >
              <input
                type="text"
                placeholder="Username"
                value={registerUsername}
                onChange={(event) => setRegisterUsername(event.target.value)}
              />
              <input
                type="text"
                placeholder="Display name"
                value={registerDisplayName}
                onChange={(event) => setRegisterDisplayName(event.target.value)}
              />
              <input
                type="password"
                placeholder="Password"
                value={registerPassword}
                onChange={(event) => setRegisterPassword(event.target.value)}
              />
              <input
                type="password"
                placeholder="Confirm password"
                value={registerConfirmPassword}
                onChange={(event) => setRegisterConfirmPassword(event.target.value)}
              />
              <button type="submit" disabled={isAuthSubmitting}>
                {isAuthSubmitting ? 'Creating...' : 'Create user'}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

export function LoginModal({ session }: { session: SessionApi }) {
  const {
    authSession,
    showLoginModal,
    setShowLoginModal,
    isAuthSubmitting,
    loginUsername,
    setLoginUsername,
    loginPassword,
    setLoginPassword,
    handleLocalLogin,
  } = session;

  return (
      <Modal
        open={showLoginModal && !authSession?.authenticated}
        onClose={() => setShowLoginModal(false)}
        className="first-run-card"
        ariaLabel="Log in"
      >
        <h2>Log in</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleLocalLogin();
          }}
        >
          <input
            type="text"
            placeholder="Username"
            value={loginUsername}
            onChange={(event) => setLoginUsername(event.target.value)}
          />
          <input
            type="password"
            placeholder="Password"
            value={loginPassword}
            onChange={(event) => setLoginPassword(event.target.value)}
          />
          <div className="modal-actions">
            <button type="submit" disabled={isAuthSubmitting}>
              {isAuthSubmitting ? 'Signing in...' : 'Log in'}
            </button>
            <button type="button" onClick={() => setShowLoginModal(false)} disabled={isAuthSubmitting}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
  );
}
