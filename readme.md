# loopar-install

Official CLI to scaffold a **Loopar Framework** project: clones the default repository, ensures **Yarn 4.x** via **Corepack**, installs dependencies, saves the core port, and optionally opens the tenant manager.

## Requirements

- **Node.js 22+** — the exact minimum is the framework's own (`engines.node` in its `package.json`, currently `>=22.22.0`); the installer checks it right after cloning
- **Git** ([downloads](https://git-scm.com/downloads))
- **Corepack** (bundled with Node; the installer can enable it when needed)
- **Caddy** (optional) — routes `http://<tenant>.localhost` to the core. Loopar tries to install it on first start (Homebrew / apt); without it tenants answer on the core port

## Quick start

```bash
npx loopar-install@latest my-loopar-app
```

You will be prompted for the project folder (if omitted), port, and whether to open the tenant manager.

When it finishes, the `dev` tenant is at:

- `http://dev.localhost` — through Caddy
- `http://dev.localhost:<port>` — straight to the core

The core finds the tenant by host name, so plain `http://localhost:<port>` answers "Tenant not identified".

### Non-interactive (CI / scripts)

```bash
npx loopar-install@latest my-loopar-app --yes --skip-start
```

With `--yes`, the installer uses safe defaults, skips confirmations, and runs Corepack/Yarn setup automatically when your Yarn is not compatible. It never calls `sudo` in this mode: if Corepack can't be enabled without it, the installer stops and prints the command.

## Commands

| Command | Description |
|--------|-------------|
| `loopar-install [folderName]` | Create a project in `folderName` (an existing Loopar project there is reused; any other existing folder is refused) |
| `loopar-install doctor` | Print environment diagnostics (Node, Corepack, Yarn, Git, Caddy, port 80) |

## Options

| Option | Description |
|--------|-------------|
| `-p, --port <n>` | Core HTTP port (1024–65535). If omitted, you are prompted (unless `--yes`, default `3000`). If it is busy the next free one is used. Saved to `config/core.json`. |
| `-y, --yes` | Non-interactive mode: no prompts; auto-fix Yarn via Corepack when needed. |
| `-q, --quiet` | Minimal banner. |
| `-v, --verbose` | Print stack traces on errors. |
| `--skip-install` | Skip `yarn install` (with `--skip-start`, Yarn is not required at all). |
| `--skip-start` | Do not open the tenant manager (`yarn start`) after install. |
| `--production` | Deprecated, ignored — dev/prod is one switch for the whole core: `yarn build && yarn prod`. |
| `--source <path>` | Copy from a local Loopar checkout instead of cloning (the files `git ls-files` lists, plus uncommitted work). For testing the installer against a branch. |

## Yarn 4.x and Corepack

- The installer expects **Yarn 4.x.x** on your PATH.
- If Yarn is missing or not 4.x, it runs **`corepack prepare yarn@4.18.1 --activate`** as the recommended pin; any **4.x.x** is accepted afterward.
- Inside the project, Corepack uses the exact version the framework pins in `packageManager`.
- If Corepack activates Yarn but `yarn --version` still looks wrong, **open a new terminal** and run again.

## PM2

Loopar bundles its own `pm2` and runs it with `PM2_HOME=<project>/.pm2/`, isolated from a global one. Use the Yarn scripts (`yarn start`, `yarn serve`, `yarn logs`…) rather than a global `pm2` command.

## Troubleshooting

1. Run **`loopar-install doctor`** and follow the suggested fix lines.
2. Ensure **`yarn --version`** prints **4.x.x**.
3. On permission errors after past installs, avoid `sudo` inside the project directory so `node_modules` stays owned by your user.

## Local development

```bash
git clone <this-repo>
cd loopar-install
npm install
npm test
```

`npm test` runs a fast check (`node --check`), `loopar-install doctor` and `--help`. For a dry run that clones the framework without installing dependencies (needs Git and network), use:

```bash
npm run test:smoke
```

## Links

- [Loopar docs](https://loopar.build)
- [Framework issues](https://github.com/alphabit-technology/loopar-framework/issues)
