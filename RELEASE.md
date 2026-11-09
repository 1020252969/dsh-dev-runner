  Release checklist

Everything this repository needs before `npm publish` and before the listing PR.
Ordered so each step only depends on the ones above it.

   1. Local (done, repeatable)

```bash
npm install              only for @deepseek-ai/schemastery (peer + dev)
npm test                 147 checks: 38 discovery, 16 store, 6 config, 44 host, 21 client, 22 render
npm pack --dry-run       14 files, ~100 kB packed / ~334 kB unpacked
```

Reinstall into a profile after changing `lib/` (a `file:` dependency is copied,
not linked, so editing the checkout changes nothing on its own):

```bash
dsh plugin --profile <name> remove dsh-dev-runner
dsh plugin --profile <name> add 'file:/path/to/dsh-dev-runner'
```

A **host restart** is required after replacing an installed bundle: the loader
keeps the previous JS generation until it recomposes.

   2. GitHub

The listing only accepts `github.com` repositories: its CI reads the repository's
`package.json`, checks the repository age, and every asset URL it will display
must be GitHub-hosted. GitHub is therefore the repository the listing points at,
and the one `repository` in `package.json` names.

The checkout's HTTPS egress is broken on this machine (`getaddrinfo() thread failed
to start`) and GitHub refuses SSH, so the push goes through the REST API:
`PUT /repos/<owner>/<repo>/contents/<path>` with a base64 blob, or `POST /git/refs`
to build a tree. Do not fall back to interactive credential-manager auth — it
blocks on a dialog nothing can answer.

1. A public repository `dsh-dev-runner`, created **empty** (no README, no
   .gitignore, no licence — an initialised repository makes the first push conflict).
2. The `dsh-plugin` topic on it.
3. Push `main` (REST, per above).
4. Wait until the repository is **one day old**; the gate refuses younger
   repositories and re-runs by itself — an empty commit does not re-trigger it.

   3. npm

The name `dsh-dev-runner` is free (checked: `npm view dsh-dev-runner` → 404).
Version in `package.json` must match the tag and the release notes.

The account has 2FA on, so publishing needs a **Granular Access Token** with
`Bypass 2FA` ticked, written to `~/.npmrc` as
`//registry.npmjs.org/:_authToken=`. `npm login` cannot do this unattended.
Note that such a token can publish but **cannot unpublish** — for a version
removal you need the other kind.

```bash
npm publish --access public
```

`repository` in `package.json` must point at the repository the listing carries
(the GitHub URL — the listing auto-maps npm packages by that field, and a `npm:`
key written into an entry file is rejected).

   4. Listings PR

One file, nothing else:

```
data/plugins/<owner>__<repo>.yml
```

```yaml
url: https://github.com/1020252969/dsh-dev-runner
name: 1020252969/dsh-dev-runner
category: dev
description:
  en: ...
  zh: ...
icon: https://raw.githubusercontent.com/1020252969/dsh-dev-runner/main/assets/icon-180.png
```

Rules that apply to this plugin specifically:

- `dsh.bundle` is declared in `package.json` — the most common rejection
  reason is declaring only `dsh.client`, which is not installable.
- The `description.en` line must be true of the code: it names scanning, matching
  the start command, dependency-ordered starts and proven port readiness, all of
  which `lib/discover.js` and `lib/index.js` implement.
- `icon` must be GitHub-hosted **raster**; SVG is refused, so the entry points at
  the rendered PNG, not `icon.svg`.
- Screenshots are declared in *this* repository (`screenshots.json`), not in
  the listing: 1–8 relative paths, no leading `/`, no `..`.
- Change only this entry file. The two READMEs in that repository are generated;
  editing them by hand is how PRs become unmergeable.

   5. Screenshots (not declared — deliberately)

The three shots this plugin would want are not captured yet, so nothing is
declared. `screenshots.json` listing files that do not exist is worse than
declaring none: the listing's probe reads each path and drops dead images, and a
410 on every shot is a visible defect. Storefronts fall back to extracting
images from the README when a repository declares nothing.

| File | What it should show |
| --- | --- |
| `assets/screenshot-panel.png` | the sidebar panel: project list with state dots, one project's coloured log, the filter box |
| `assets/screenshot-discovery.png` | the scan panel: candidates with their evidence, the per-command checkboxes |
| `assets/screenshot-header.png` | the session header pill: `n/m` plus the start-all / stop-all button |

They must be captured from a running host with the panel open. The host's browser
credential is a per-process random token held only in memory, so a script cannot
reuse it — and the plugin cannot screenshot itself. Capture by hand, then add
`screenshots.json` and the PNGs to `files`.

   6. The published artifact was checked, not assumed

`npm pack` → extract → import, and install it into a profile from the tarball:

| Check | Result |
| --- | --- |
| `dsh.bundle.patch` in the shipped `package.json` | `./cordis.patch.yml`, and that file exists and names the package |
| `dsh.client.platform` | `web` (the browser half is shipped) |
| every relative path in `exports`/`main`/`dsh.bundle` | resolves inside the tarball |
| the four `lib/*.js` modules import from the extracted copy | `Config`, `Runner`, `createHandler`, `discoverProjects`, `ProjectStore` all resolve |
| the schema validates a project and fills defaults | `readyTimeoutMs: 120000`, `args: ""`, `env: {}` |
| `lib/client.js` shape | one `window.__ModuleLoader__.load`, zero top-level `import`/`export`, two `require`s (react, react/jsx-runtime) |
| a scan run from the tarball | 2 candidates in 5 directories, same as the checkout |
| `dsh plugin add <the .tgz>` into a profile | installs, its peer resolves from the profile, `lib/index.js` imports with `RUNNER_VERSION: 2` |

What that does **not** prove: rendering. The browser half needs a live GUI session
(the host's browser credential is a per-process random token, so it cannot be
reused from a script), which is why the screenshots are captured by hand.
