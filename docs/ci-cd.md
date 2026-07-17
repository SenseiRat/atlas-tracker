# CI/CD Pipeline

A single Gitea/Forgejo Actions workflow ([`.gitea/workflows/ci.yml`](../.gitea/workflows/ci.yml))
that runs on every push to `main` (and on PRs targeting `main`). It lints, scans,
tests, builds the container image, and publishes it to the built-in
Gitea/Forgejo container registry.

## Pipeline at a glance

```
push to main
  │
  ├── backend      : Ruff lint (report) + pytest        (test = gate)
  ├── frontend     : ESLint + tsc (report) + vitest      (test = gate)
  ├── secrets      : Gitleaks                            (report)
  ├── sast         : Semgrep                             (report)
  │
  └── build-and-publish  (needs all four above; main pushes only)
        build image → Trivy scan (report) → push :version, :version-sha, :latest
```

## Tool choices — one deliberate tool per domain

Each scanner is here for a distinct slice of coverage; nothing overlaps.

| Domain | Tool | Why this one, and what it covers |
| --- | --- | --- |
| Python lint / quality | **Ruff** | A single Rust binary that replaces flake8 + isort + pyupgrade + bugbear and runs in well under a second — ideal for a resource-constrained homelab runner. Catches unused imports, likely bugs, and dead code. |
| Frontend lint / quality | **ESLint** + `tsc` | ESLint (flat config, `typescript-eslint` + `react-hooks`) is the standard for TS/React; the `tsc --noEmit` typecheck catches type errors that lint rules can't. |
| SAST (app security) | **Semgrep** | One tool that covers **both** the Python backend and the TS/React frontend with maintained security rulesets (`--config auto`). Finds insecure code patterns: injection, unsafe deserialization, dangerous defaults, XSS sinks. |
| Secrets | **Gitleaks** | Single Go binary, scans the **full git history** (not just the tree), so a key committed and later "removed" is still caught. The de-facto homelab choice. |
| Dependency + image CVEs | **Trivy** | Scans the image you are about to ship — OS packages *and* installed pip dependencies — against known-CVE databases. This is the gap Semgrep (code patterns) and Gitleaks (secrets) do **not** cover: vulnerable third-party dependencies, which are the most common real-world exposure. |
| Automated tests | **pytest** + **vitest** | The suites already in the repo. |

Why these three security tools and not more: **Semgrep** = *how the code is written*,
**Trivy** = *what the code depends on*, **Gitleaks** = *what shouldn't be in the repo
at all*. Those are the three orthogonal questions worth asking on a personal
project. Adding a fourth (Bandit, Grype, Checkov, …) would only duplicate one of
these.

## Gate policy

This is intentionally **not a hard security gate**.

- **Hard gates** — the two test suites (pytest, vitest) and the image build. If
  these fail, nothing is published.
- **Report-only** — every quality/security scanner. They write a summary to the
  run's **Job Summary** and upload their SARIF/JSON reports as artifacts, but
  they never fail the build (`continue-on-error` / `--exit-code 0`).

To promote any scanner to a blocking gate, remove its `continue-on-error: true`
(or its `--exit-code 0`) in the workflow.

## One-time setup

1. **Enable Actions** on the repo (Gitea: *Settings → Actions*; Forgejo: same),
   and register a runner with the `ubuntu-latest` label whose host has **Docker
   available** (the `build-and-publish` job builds and pushes an image). The
   standard `act_runner` config with the Docker socket mounted works.

2. **Registry credentials.** The publish job logs in with, in order of
   preference:
   - a repo/org secret **`REGISTRY_TOKEN`** — a Gitea/Forgejo access token with
     `package: write` scope (recommended), or
   - the automatic per-run `github.token` as a fallback.

   The login **user** must own the token. It defaults to the pusher
   (`github.actor`); set a repo/org variable **`REGISTRY_USER`** if the token
   belongs to a different account (e.g. a dedicated `ci` user).

3. **Registry host (optional).** By default the host is derived from the
   instance URL (e.g. `https://git.example.com` → `git.example.com`). Override it
   by setting a repo/org **variable** `REGISTRY` if your registry lives
   elsewhere.

No other configuration is required — Semgrep runs without an account
(`--metrics off`), and Ruff/Gitleaks/Trivy pin their own versions in the
workflow.

## Published tags

On each push to `main` the same image is pushed under three tags:

| Tag | Example | Purpose |
| --- | --- | --- |
| `latest` | `git.example.com/senseirat/trip-tracker:latest` | Always the newest main build |
| `<version>` | `…:0.1.0` | Human-readable version, read from `frontend/package.json` |
| `<version>-<sha>` | `…:0.1.0-1a2b3c4` | Immutable, traceable to an exact commit |

## Local config files

- [`ruff.toml`](../ruff.toml) — Ruff rule selection (correctness/style; import
  ordering and line-length are intentionally off to avoid noise, and the
  star-import re-export pattern in `server/app/` is scoped out).
- [`frontend/eslint.config.js`](../frontend/eslint.config.js) — ESLint flat config.
- [`.gitleaks.toml`](../.gitleaks.toml) — extends the default Gitleaks rules and
  allowlists this repo's known-safe placeholders (`.env.example`, fixtures).

## Mirroring to GitHub

Gitea is the hosting source of truth; GitHub is a read-only public mirror. The
sync is **purely outbound** — Gitea pushes up to GitHub, GitHub never connects
down. Mirroring is handled by Gitea's built-in push mirror, not by CI:

*Repo Settings → Repository → Mirror Settings → Push mirror* — add
`https://github.com/<owner>/<repo>.git`, a GitHub PAT (fine-grained with
*Contents: read and write*, or classic `repo` scope) as the password, and tick
*sync on commit*. This handles all refs **including branch deletions**
automatically, with zero CI involvement.

## Notes / possible extensions

- The scanners currently run on `x86_64`. If your runner is ARM, adjust the
  Gitleaks/Trivy download URLs.
- The image is built single-arch (runner's architecture). Add `docker buildx`
  for multi-arch if you deploy to mixed hardware.
- `actions/cache` is intentionally omitted to maximise portability across Gitea
  and Forgejo instances; add it for pip/npm if your instance runs a cache server.
