#!/usr/bin/env node

/**
 * Official Loopar installer — Git clone, Yarn 4.x (Corepack), guided or CI mode.
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import fs from 'fs';
import net from 'node:net';
import path from 'path';
import { fileURLToPath } from 'url';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();

const DEFAULT_REPO = 'https://github.com/alphabit-technology/loopar-framework.git';
/** Recommended Yarn release when activating via Corepack (any 4.x.x is accepted at runtime). */
const RECOMMENDED_YARN_VERSION = '4.18.1';
const REQUIRED_YARN_MAJOR = 4;
/** The installer itself runs on this Node major or newer; the framework's exact
 *  requirement is read from its own package.json after cloning. */
const MIN_NODE_MAJOR = 22;
/** The tenant a fresh install comes with (created by the framework's postinstall). */
const DEV_DOMAIN = 'dev.localhost';

/**
 * Fallback filter for a --source folder that is not a git checkout: skip
 * dependencies, build output and everything Loopar generates at runtime, so
 * the copy starts empty like a fresh clone. (A git checkout is copied from
 * `git ls-files` instead — exactly what a clone would bring.)
 */
const EXCLUDE_TOP = new Set([
  'node_modules',
  '.git',
  'sites',
  'config',
  'backups',
  'uploads',
  'build',
  'dist',
  '.pm2',
  '_to_delete'
]);
const EXCLUDE_PNP_FILES = new Set(['.pnp.cjs', '.pnp.loader.mjs']);
const EXCLUDE_YARN_SUBPATHS = new Set([
  'cache',
  'install-state.gz',
  'unplugged',
  'build-state.yml'
]);

function getCliVersion() {
  try {
    const pkgPath = path.join(__dirname, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function validateFolderName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return 'Folder name is required';
  if (!/^[a-z0-9-_]+$/i.test(trimmed)) {
    return 'Folder name can only contain letters, numbers, hyphens, and underscores';
  }
  return true;
}

function printBanner(quiet) {
  if (quiet) {
    console.log(chalk.cyan.bold('Loopar installer'));
    return;
  }
  console.log(chalk.cyan.bold(`
╔═══════════════════════════════════════╗
║                                       ║
║     🚀 Create Loopar Project          ║
║                                       ║
╚═══════════════════════════════════════╝
  `));
}

function runCommand(command, options = {}) {
  const { cwd = process.cwd(), envOverride = {}, silent = false } = options;
  
  try {
    const result = execSync(command, {
      cwd,
      stdio: silent ? 'pipe' : 'inherit',
      env: { ...process.env, ...envOverride },
      encoding: 'utf8'
    });
    return result;
  } catch (err) {
    const errorMsg = [
      `Command failed: "${command}"`,
      `Working directory: ${cwd}`,
      err.message
    ].join('\n');
    
    const error = new Error(errorMsg);
    error.originalError = err;
    error.command = command;
    error.cwd = cwd;
    error.stderr = err.stderr?.toString();
    error.stdout = err.stdout?.toString();
    
    throw error;
  }
}

function gitCliAvailable() {
  try {
    execSync('git --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function checkNodeVersion() {
  const version = process.version;
  const major = parseInt(version.split('.')[0].substring(1), 10);
  return {
    version,
    major,
    supported: major >= MIN_NODE_MAJOR,
    supportsCorepack: major >= 18
  };
}

function assertSupportedNode() {
  const { version, supported } = checkNodeVersion();
  if (!supported) {
    console.error(chalk.red(`\n❌ Node.js ${version} is not supported`));
    console.error(chalk.yellow(`Loopar requires Node.js ${MIN_NODE_MAJOR} or higher.\n`));
    console.error(chalk.cyan('https://nodejs.org/\n'));
    process.exit(1);
  }
}

/**
 * The framework states its own Node requirement (package.json → engines.node,
 * e.g. ">=22.22.0"). Checked here, right after the clone: Yarn Berry doesn't
 * enforce engines, and the framework's own check only runs once every
 * dependency has been downloaded.
 */
function assertFrameworkNode(targetPath) {
  let range;
  try {
    range = JSON.parse(fs.readFileSync(path.join(targetPath, 'package.json'), 'utf8'))?.engines?.node;
  } catch {
    return;
  }
  const min = String(range || '').trim().match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!min) return; // no requirement, or a range this simple check doesn't read

  const required = [min[1], min[2] || 0, min[3] || 0].map(Number);
  const current = parseSemver(process.version.slice(1));
  if (!current) return;
  const have = [current.major, current.minor, current.patch];
  const cmp = have.map((n, i) => n - required[i]).find((d) => d !== 0) || 0;
  if (cmp >= 0) {
    console.log(chalk.green(`✓ Node.js ${process.version} (Loopar needs ${range})\n`));
    return;
  }

  throw new Error(
    `This version of Loopar needs Node.js ${range} — found ${process.version}.\n` +
    `Update Node (https://nodejs.org/) and run the installer again; the project folder can stay.`
  );
}

function corepackAvailable() {
  try {
    execSync('corepack --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function parseSemver(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function getYarnCompatibilityStatus(version) {
  if (!version) return 'not-installed';
  if (version === RECOMMENDED_YARN_VERSION) return 'exact';

  const current = parseSemver(version);
  if (!current) return 'invalid';
  if (current.major < REQUIRED_YARN_MAJOR) return 'too-old-major';
  if (current.major > REQUIRED_YARN_MAJOR) return 'too-new-major';
  return 'compatible-major';
}

function getYarnVersion() {
  try {
    const version = execSync('yarn --version', { 
      stdio: 'pipe', 
      encoding: 'utf8' 
    }).trim();
    const parsed = parseSemver(version);
    const major = parsed?.major ?? null;
    const compatibilityStatus = getYarnCompatibilityStatus(version);

    return {
      available: true,
      version,
      major,
      isBerry: major >= 2,
      compatibilityStatus,
      isCompatible: compatibilityStatus === 'exact' || compatibilityStatus === 'compatible-major'
    };
  } catch {
    return {
      available: false,
      version: null,
      major: null,
      isBerry: false,
      compatibilityStatus: 'not-installed',
      isCompatible: false
    };
  }
}

/**
 * Enable Corepack. `sudo` is only tried in an interactive run: with --yes
 * nobody is there to type a password.
 */
async function enableCorepack({ allowSudo = true } = {}) {
  const spinner = ora('Enabling Corepack...').start();

  try {
    execSync('corepack enable', { stdio: 'pipe' });
    spinner.succeed('Corepack enabled');
    return true;
  } catch (err) {
    if (!allowSudo) {
      spinner.fail('Failed to enable Corepack');
      console.error(chalk.yellow('\nRun it once yourself, then run the installer again:'));
      console.error(chalk.cyan('  sudo corepack enable\n'));
      return false;
    }
    try {
      spinner.text = 'Enabling Corepack (requires sudo)...';
      console.log();
      execSync('sudo corepack enable', { stdio: 'inherit' });
      spinner.succeed('Corepack enabled');
      return true;
    } catch (sudoErr) {
      spinner.fail('Failed to enable Corepack');
      return false;
    }
  }
}

/**
 * Setup mandatory Yarn version using Corepack
 */
async function setupYarnWithCorepack({ yes = false } = {}) {
  console.log(chalk.cyan('\n🔧 Setting up Yarn environment...\n'));
  
  const nodeInfo = checkNodeVersion();
  if (!nodeInfo.supportsCorepack) {
    console.error(chalk.red(`❌ Node.js ${nodeInfo.version} does not support Corepack`));
    console.error(chalk.yellow(`Loopar requires Node.js ${MIN_NODE_MAJOR} or higher\n`));
    console.error(chalk.white('Please upgrade Node.js:'));
    console.error(chalk.cyan('  https://nodejs.org/\n'));
    return false;
  }

  console.log(chalk.gray(`✓ Node.js ${nodeInfo.version}\n`));

  if (!corepackAvailable()) {
    console.error(chalk.red('❌ Corepack not found'));
    console.error(chalk.yellow('Corepack ships with Node.js; if yours lacks it: npm install -g corepack\n'));
    return false;
  }

  console.log(chalk.gray('✓ Corepack available\n'));

  const corepackEnabled = await enableCorepack({ allowSudo: !yes });
  if (!corepackEnabled) {
    console.error(chalk.red('\n❌ Could not enable Corepack\n'));
    return false;
  }

    const spinner = ora(`Installing Yarn ${RECOMMENDED_YARN_VERSION} (Corepack)...`).start();

  try {
    execSync(`corepack prepare yarn@${RECOMMENDED_YARN_VERSION} --activate`, {
      stdio: 'pipe',
      timeout: 120000
    });

    spinner.text = 'Verifying Yarn installation...';

    const after = getYarnVersion();
    if (!after.isCompatible) {
      spinner.fail(`Yarn ${after.version ?? 'unknown'} detected (expected 4.x.x)`);
      console.error(chalk.red('\n❌ Corepack did not activate a compatible Yarn 4.x release\n'));
      console.error(chalk.yellow('⚠️  IMPORTANT: You may need to close and reopen your terminal.\n'));
      console.error(chalk.white('After reopening terminal, verify with:'));
      console.error(chalk.cyan('  yarn --version  # Should show 4.x.x\n'));
      return false;
    }

    spinner.succeed(`Yarn ${after.version} activated`);

    console.log(chalk.yellow('\n⚠️  IMPORTANT: If installation fails, close and reopen your terminal'));
    console.log(chalk.yellow('Then run this installer again\n'));

    return true;

  } catch (err) {
    spinner.fail('Failed to setup Yarn');

    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    const stdout = err.stdout ? err.stdout.toString().trim() : '';
    const combined = `${stderr}\n${stdout}\n${err.message || ''}`;

    console.error(chalk.red('\n❌ corepack prepare yarn@' + RECOMMENDED_YARN_VERSION + ' --activate failed\n'));
    if (stderr) {
      console.error(chalk.yellow('stderr:'));
      console.error(chalk.gray(stderr) + '\n');
    }
    if (stdout) {
      console.error(chalk.yellow('stdout:'));
      console.error(chalk.gray(stdout) + '\n');
    }
    if (!stderr && !stdout) {
      console.error(chalk.gray(err.message + '\n'));
    }

    // Specific diagnosis: cache owned by root (usually because corepack was
    // previously enabled with sudo). corepack prepare then can't write to it.
    const cachePathMatch = combined.match(/(\/[^\s'"]*\/\.cache\/node\/corepack[^\s'"]*)/);
    const isPermDenied = /EACCES|permission denied/i.test(combined);
    if (isPermDenied && cachePathMatch) {
      const cacheDir = cachePathMatch[1].split('/.cache/node/corepack')[0] + '/.cache/node/corepack';
      console.error(chalk.red.bold('🔑 Permission problem on Corepack cache.\n'));
      console.error(chalk.white('Looks like ' + chalk.cyan(cacheDir) + ' is owned by root,'));
      console.error(chalk.white('probably from a previous "sudo corepack enable". Fix it once with:\n'));
      console.error(chalk.cyan('    sudo chown -R "$USER" ' + cacheDir + '\n'));
      console.error(chalk.gray('  (or ' + chalk.cyan('sudo rm -rf ' + cacheDir) + chalk.gray(' — Corepack will recreate it)\n')));
      console.error(chalk.white('Then re-run this installer.\n'));
      return false;
    }

    console.error(chalk.cyan('💡 Common fixes:\n'));
    console.error(chalk.white('  • Update Corepack itself (signature/key errors):'));
    console.error(chalk.gray('      npm install -g corepack@latest\n'));
    console.error(chalk.white('  • Behind a proxy / offline? Check your network and registry:'));
    console.error(chalk.gray('      corepack prepare yarn@' + RECOMMENDED_YARN_VERSION + ' --activate    # run manually to see full output\n'));
    console.error(chalk.white('  • Bypass strict signature check (use with caution):'));
    console.error(chalk.gray('      COREPACK_INTEGRITY_KEYS=0 corepack prepare yarn@' + RECOMMENDED_YARN_VERSION + ' --activate\n'));

    return false;
  }
}

/**
 * Ensure required Yarn version is available
 */
async function ensureYarnVersion({ yes = false } = {}) {
  const yarnInfo = getYarnVersion();
  
  console.log(chalk.cyan('\n📦 Checking Yarn...\n'));
  
  if (yarnInfo.available) {
    if (yarnInfo.isCompatible) {
      console.log(chalk.green(`✓ Yarn ${yarnInfo.version} ready\n`));
      return {
        success: true,
        version: yarnInfo.version
      };
    } else {
      console.log(chalk.yellow(`⚠️  Yarn ${yarnInfo.version} detected`));
      switch (yarnInfo.compatibilityStatus) {
        case 'too-old-major':
          console.log(chalk.yellow(`Detected Yarn major ${yarnInfo.major}. Loopar requires Yarn 4.x.x.`));
          console.log(chalk.yellow('Action: upgrade Yarn through Corepack.\n'));
          break;
        case 'too-new-major':
          console.log(chalk.yellow(`Detected newer Yarn major (${yarnInfo.version}).`));
          console.log(chalk.yellow('Action: switch to Yarn 4.x.x for this installer.\n'));
          break;
        default:
          console.log(chalk.yellow('Loopar requires Yarn 4.x.x\n'));
      }
      
      if (yes) {
        const success = await setupYarnWithCorepack({ yes });
        if (!success) {
          console.error(chalk.red('Setup failed. Please try manual installation.\n'));
          process.exit(1);
        }
      } else {
        const { action } = await inquirer.prompt([
          {
            type: 'list',
            name: 'action',
            message: 'How would you like to proceed?',
            choices: [
              { name: `Setup Yarn ${RECOMMENDED_YARN_VERSION} via Corepack (recommended)`, value: 'corepack' },
              { name: 'Show manual installation steps', value: 'manual' },
              { name: 'Exit', value: 'exit' }
            ]
          }
        ]);
        
        if (action === 'exit') {
          console.log(chalk.gray('\nExiting.\n'));
          process.exit(0);
        }
        
        if (action === 'manual') {
          console.log(chalk.cyan('\n📋 Manual installation steps:\n'));
          console.log(chalk.white('  1. Enable Corepack:'));
          console.log(chalk.gray('     corepack enable\n'));
          console.log(chalk.white('  2. Install a Yarn 4.x release (recommended pin):'));
          console.log(chalk.gray(`     corepack prepare yarn@${RECOMMENDED_YARN_VERSION} --activate\n`));
          console.log(chalk.white('  3. Close and reopen your terminal\n'));
          console.log(chalk.white('  4. Verify:'));
          console.log(chalk.gray('     yarn --version  # Should show 4.x.x\n'));
          console.log(chalk.white('  5. Run this installer again\n'));
          process.exit(0);
        }
        
        const success = await setupYarnWithCorepack({ yes });
        if (!success) {
          console.error(chalk.red('Setup failed. Please try manual installation.\n'));
          process.exit(1);
        }
      }
    }
  } else {
    console.log(chalk.yellow('⚠️  Yarn not found\n'));
    
    const success = await setupYarnWithCorepack({ yes });
    if (!success) {
      console.error(chalk.red('Setup failed. Please try manual installation.\n'));
      process.exit(1);
    }
  }

  const finalYarnInfo = getYarnVersion();
  
  if (!finalYarnInfo.isCompatible) {
    console.error(chalk.red('\n❌ Yarn setup verification failed\n'));
    console.error(chalk.yellow('Current Yarn version:'), finalYarnInfo.version);
    console.error(chalk.yellow('Required version: 4.x.x\n'));
    
    console.error(chalk.yellow('⚠️  This usually means you need to restart your terminal\n'));
    
    console.log(chalk.cyan('Steps to fix:\n'));
    console.log(chalk.white('  1. Close this terminal completely'));
    console.log(chalk.white('  2. Open a new terminal window'));
    console.log(chalk.white('  3. Verify Yarn version:'));
    console.log(chalk.gray('     yarn --version  # Should show 4.x.x'));
    console.log(chalk.white('  4. Run this installer again\n'));
    
    process.exit(1);
  }

  console.log(chalk.green(`✅ Yarn ${finalYarnInfo.version} ready\n`));
  
  return {
    success: true,
    version: finalYarnInfo.version
  };
}

/**
 * Clone repository
 */
async function cloneRepo(repoUrl, targetPath) {
  if (!gitCliAvailable()) {
    throw new Error(
      chalk.red('git CLI not found.') + 
      '\nPlease install Git: ' + 
      chalk.blue.underline('https://git-scm.com/downloads')
    );
  }

  const spinner = ora(`Cloning ${chalk.cyan(repoUrl)}...`).start();

  try {
    // The default branch only, without history: faster, and a stale branch on
    // the remote can't get in the way.
    runCommand(`git clone --depth 1 --single-branch ${repoUrl} "${targetPath}"`, { silent: true });
    spinner.succeed(`Repository cloned to ${chalk.cyan(targetPath)}`);
  } catch (err) {
    spinner.fail('Clone failed');
    throw new Error(`git clone failed: ${err.message}`);
  }
}

/**
 * Copy a local Loopar source tree into targetPath instead of cloning from git.
 * Used by --source <path> for testing the installer against an in-development
 * checkout without round-tripping through GitHub.
 */
function shouldExcludeFromSource(absSource, src) {
  const rel = path.relative(absSource, src);
  if (!rel || rel.startsWith('..')) return false;

  const parts = rel.split(path.sep);
  const top = parts[0];

  if (EXCLUDE_TOP.has(top)) return true;
  if (EXCLUDE_PNP_FILES.has(top)) return true;
  if (top === '.yarn' && parts.length >= 2 && EXCLUDE_YARN_SUBPATHS.has(parts[1])) return true;

  return false;
}

/**
 * Files a clone of `absSource` would bring, plus work not committed yet:
 * tracked files and untracked ones that .gitignore doesn't cover. Null when
 * the folder is not a git checkout.
 */
function gitSourceFiles(absSource) {
  if (!fs.existsSync(path.join(absSource, '.git')) || !gitCliAvailable()) return null;
  try {
    const out = execSync('git ls-files -co --exclude-standard -z', {
      cwd: absSource,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

async function copyFromLocal(sourcePath, targetPath) {
  const absSource = path.resolve(sourcePath);

  if (!fs.existsSync(absSource)) {
    throw new Error(`--source path does not exist: ${absSource}`);
  }
  if (!fs.statSync(absSource).isDirectory()) {
    throw new Error(`--source path is not a directory: ${absSource}`);
  }
  if (!isLooparProject(absSource)) {
    throw new Error(`--source path does not look like a Loopar project: ${absSource}`);
  }
  if (path.resolve(targetPath) === absSource) {
    throw new Error(`--source and target are the same folder: ${absSource}`);
  }

  const spinner = ora(`Copying from ${chalk.cyan(absSource)}...`).start();

  try {
    const files = gitSourceFiles(absSource);
    if (files) {
      let copied = 0;
      for (const rel of files) {
        const from = path.join(absSource, rel);
        let stat;
        try { stat = fs.lstatSync(from); } catch { continue; } // deleted, not committed yet
        if (stat.isDirectory()) continue;
        const to = path.join(targetPath, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
        else fs.copyFileSync(from, to);
        copied++;
      }
      spinner.succeed(`Copied ${copied} files to ${chalk.cyan(targetPath)}`);
      console.log(chalk.gray('  Same files a clone would bring (git ls-files), plus uncommitted work.'));
      return;
    }

    fs.cpSync(absSource, targetPath, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
      errorOnExist: false,
      force: true,
      filter: (src) => !shouldExcludeFromSource(absSource, src)
    });
    spinner.succeed(`Copied source to ${chalk.cyan(targetPath)}`);
    console.log(
      chalk.gray(
        `  Not a git checkout — skipped: ${[...EXCLUDE_TOP].join(', ')}, .yarn/{cache,unplugged,…}, .pnp.*`
      )
    );
  } catch (err) {
    spinner.fail('Local copy failed');
    throw new Error(`copy from --source failed: ${err.message}`);
  }
}

/** A Loopar framework checkout: its package name, or its core package. */
function isLooparProject(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg?.name === 'loopar-framework') return true;
  } catch {
    return false;
  }
  return fs.existsSync(path.join(dir, 'packages', 'loopar', 'package.json'));
}

/**
 * Remove legacy Yarn Classic config only. Yarn 4 Berry uses `.yarnrc.yml`; do not delete it.
 */
async function cleanYarnConfig(targetPath) {
  const yarnrcOldPath = path.join(targetPath, '.yarnrc');
  
  if (fs.existsSync(yarnrcOldPath)) {
    console.log(chalk.gray('Removing legacy .yarnrc (Yarn Classic)'));
    fs.unlinkSync(yarnrcOldPath);
    console.log(chalk.green('✓ Removed legacy Yarn config\n'));
  }
}

/**
 * Fix package.json to use required Yarn version
 */
async function fixPackageManager(targetPath) {
  const spinner = ora('Configuring package manager...').start();
  
  try {
    const pkgJsonPath = path.join(targetPath, 'package.json');
    
    if (!fs.existsSync(pkgJsonPath)) {
      spinner.fail('package.json not found');
      return false;
    }

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    
    if (pkgJson.packageManager) {
      const currentPM = pkgJson.packageManager;
      
      if (!currentPM.startsWith(`yarn@${REQUIRED_YARN_MAJOR}.`)) {
        spinner.info(`Found packageManager: ${currentPM}`);
        console.log(chalk.yellow(`Replacing with yarn@${RECOMMENDED_YARN_VERSION}\n`));
        
        pkgJson.packageManager = `yarn@${RECOMMENDED_YARN_VERSION}`;
        
        fs.writeFileSync(
          pkgJsonPath, 
          JSON.stringify(pkgJson, null, 2) + '\n',
          'utf-8'
        );
        
        spinner.succeed(`Configured packageManager: yarn@${RECOMMENDED_YARN_VERSION}`);
        return true;
      }
    } else {
      console.log(chalk.yellow('Adding packageManager field\n'));
      pkgJson.packageManager = `yarn@${RECOMMENDED_YARN_VERSION}`;
      
      fs.writeFileSync(
        pkgJsonPath, 
        JSON.stringify(pkgJson, null, 2) + '\n',
        'utf-8'
      );
      
      spinner.succeed(`Configured packageManager: yarn@${RECOMMENDED_YARN_VERSION}`);
      return true;
    }
    
    spinner.succeed('Package manager already correct');
    return true;
    
  } catch (err) {
    spinner.fail('Failed to configure package manager');
    console.error(chalk.red('\nError:'), err.message);
    return false;
  }
}

/**
 * Get project configuration through prompts
 */
function parsePortOption(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const port = parseInt(String(raw), 10);
  if (Number.isNaN(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid port: ${raw} (use 1024–65535)`);
  }
  return port;
}

async function getProjectConfig(folderName, options) {
  const fromFlag = parsePortOption(options.port);

  if (options.yes) {
    const name = (folderName && String(folderName).trim()) || 'my-loopar-project';
    const nameCheck = validateFolderName(name);
    if (nameCheck !== true) {
      throw new Error(nameCheck);
    }
    const port = fromFlag ?? 3000;
    const autoStart = !options.skipStart;
    return { folderName: name, port, autoStart };
  }

  const questions = [];

  if (!folderName) {
    questions.push({
      type: 'input',
      name: 'folderName',
      message: 'Project folder name:',
      default: 'my-loopar-project',
      validate: validateFolderName
    });
  }

  if (fromFlag === null) {
    questions.push({
      type: 'number',
      name: 'port',
      message: 'Port number:',
      default: 3000,
      validate: (input) => {
        const port = parseInt(input, 10);
        if (Number.isNaN(port) || port < 1024 || port > 65535) {
          return 'Port must be between 1024 and 65535';
        }
        return true;
      }
    });
  }

  if (!options.skipStart) {
    questions.push({
      type: 'list',
      name: 'startMode',
      message: 'Open the tenant manager (TUI) after installation?',
      choices: [
        { name: 'Yes — open the panel (it starts the core; the dev tenant is already on)', value: 'dev' },
        { name: 'No, I will run yarn start manually', value: 'skip' }
      ],
      default: 'dev'
    });
  }

  const answers = questions.length > 0 ? await inquirer.prompt(questions) : {};

  const port = fromFlag ?? parseInt(answers.port, 10);
  const startMode = answers.startMode;

  return {
    folderName: folderName || answers.folderName,
    port,
    autoStart: options.skipStart ? false : startMode !== 'skip'
  };
}

/**
 * Probe a TCP port — true when it can be bound on loopback and on every
 * interface (the core listens on loopback by default; `host` in
 * config/core.json can widen it).
 */
function canBind(port, host) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', (err) => resolve(err?.code || 'EUNKNOWN'));
    tester.once('listening', () => tester.close(() => resolve(null)));
    tester.listen(port, host);
  });
}

async function isPortFree(port) {
  return (await canBind(port, '127.0.0.1')) === null && (await canBind(port, '0.0.0.0')) === null;
}

/**
 * The core's HTTP port (Vite's HMR rides the same server, so one port is all
 * it takes). When the requested one is busy, the next free one is used.
 */
async function findAvailablePort(requestedPort, maxTries = 100) {
  const spinner = ora(`Checking port ${requestedPort}...`).start();

  if (await isPortFree(requestedPort)) {
    spinner.succeed(`Port ${chalk.cyan(requestedPort)} is available`);
    return requestedPort;
  }

  spinner.text = `Port ${requestedPort} is in use, searching the next free one...`;
  for (let p = requestedPort + 1; p < requestedPort + maxTries && p <= 65535; p++) {
    if (await isPortFree(p)) {
      spinner.warn(`Port ${requestedPort} is in use. Using ${chalk.cyan(p)} instead`);
      return p;
    }
  }

  spinner.fail('Could not find a free port');
  throw new Error(`No free port found from ${requestedPort}. Free it up or pass --port.`);
}

/**
 * The core reads its port from config/core.json. Written here so the port
 * holds for every later start, not only for the one this installer launches.
 * A project that already has a core.json keeps its own port.
 * @returns {number} the port the project runs on
 */
function persistCorePort(targetPath, port) {
  const file = path.join(targetPath, 'config', 'core.json');
  if (fs.existsSync(file)) {
    try {
      const current = Number(JSON.parse(fs.readFileSync(file, 'utf8'))?.port);
      if (Number.isInteger(current) && current > 0) {
        if (current !== port) {
          console.log(chalk.yellow(`⚠️  This project already runs on port ${current} (config/core.json) — keeping it.\n`));
        }
        return current;
      }
    } catch { /* unreadable: leave the file alone */ }
    return port;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ port }, null, 2) + '\n', 'utf8');
  console.log(chalk.gray(`Port ${port} saved to config/core.json\n`));
  return port;
}

/**
 * Check write permissions
 */
async function checkWritePermissions(dirPath) {
  try {
    const testFile = path.join(dirPath, '.write-test-' + Date.now());
    await fs.promises.writeFile(testFile, 'test');
    await fs.promises.unlink(testFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install dependencies with required Yarn version
 */
async function installDependencies(targetPath, yarnInfo, { yes = false, port } = {}) {
  console.log(chalk.cyan('🔍 Verifying Yarn version...\n'));
  
  const currentYarn = getYarnVersion();
  
  if (!currentYarn.isCompatible) {
    console.error(chalk.red(`❌ Wrong Yarn version: ${currentYarn.version}`));
    console.error(chalk.yellow('Expected: 4.x.x\n'));
    console.error(chalk.yellow('⚠️  Please close and reopen your terminal, then try again\n'));
    return false;
  }
  
  console.log(chalk.green(`✓ Yarn ${currentYarn.version} confirmed\n`));
  const installCmd = 'yarn install';
  const displayCmd = installCmd;
  
  const spinner = ora(`Installing with ${chalk.cyan(displayCmd)}...`).start();

  try {
    const pkgJsonPath = path.join(targetPath, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      spinner.fail('package.json not found');
      throw new Error(`package.json not found at ${pkgJsonPath}`);
    }

    const canWrite = await checkWritePermissions(targetPath);
    if (!canWrite) {
      spinner.fail('No write permissions');
      throw new Error(`Cannot write to ${targetPath}`);
    }

    runCommand(installCmd, {
      cwd: targetPath,
      silent: false,
      envOverride: {
        NODE_ENV: 'development',
        COREPACK_ENABLE_STRICT: '0',
        // Also read by the framework's postinstall (bin/setup/ensure-site.js).
        ...(port ? { PORT: String(port) } : {})
      }
    });
    
    spinner.succeed('Dependencies installed');
    return true;
    
  } catch (err) {
    spinner.fail('Installation failed');
    
    console.error(chalk.red('\n❌ Installation error\n'));
    console.error(chalk.yellow('Command:'), displayCmd);
    console.error(chalk.yellow('Directory:'), targetPath);
    
    if (err.stderr) {
      console.error(chalk.yellow('\nError output:'));
      console.error(chalk.gray(err.stderr));
    }
    
    const checkYarn = getYarnVersion();
    if (!checkYarn.isCompatible) {
      console.error(chalk.red('\n⚠️  Yarn version mismatch!'));
      console.error(chalk.yellow(`Current: ${checkYarn.version}`));
      console.error(chalk.yellow('Expected: 4.x.x'));
      console.error(chalk.yellow('\nClose and reopen your terminal, then try again.\n'));
    }
    
    console.error(chalk.yellow('\n💡 Manual installation:'));
    console.error(chalk.cyan(`   cd ${path.basename(targetPath)}`));
    console.error(chalk.cyan('   yarn --version  # Verify 4.x.x'));
    console.error(chalk.cyan(`   yarn install\n`));
    
    if (yes) {
      throw new Error('Dependency installation failed (--yes: aborting instead of prompting)');
    }

    const { continueAnyway } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'continueAnyway',
        message: 'Continue without installing? (Install manually later)',
        default: false
      }
    ]);
    
    if (!continueAnyway) {
      throw new Error('Aborted');
    }
    
    console.log(chalk.yellow('\n⚠️  Skipped installation\n'));
    return false;
  }
}

/**
 * Open the tenant manager. It starts the core when it isn't running.
 */
async function startTenantManager(targetPath, port) {
  console.log(chalk.cyan('\n🚀 Opening the Loopar tenant manager (TUI)...\n'));
  console.log(chalk.gray('It starts the core; the dev tenant is already on. Press q to leave the panel (the core keeps running).\n'));

  try {
    runCommand('yarn start', {
      cwd: targetPath,
      envOverride: { PORT: String(port) }
    });
  } catch (err) {
    console.log(chalk.yellow('\n⚠️  Could not open the tenant manager'));
    console.log(chalk.gray('Start manually:'));
    console.log(chalk.cyan(`   cd ${path.basename(targetPath)}`));
    console.log(chalk.cyan(`   yarn start\n`));
  }
}

/**
 * Print the closing message
 */
function printSuccessMessage(folderName, port, yarnInfo, { installed = true } = {}) {
  if (installed) {
    console.log(chalk.green.bold('\n✅ Loopar project created successfully!\n'));
  } else {
    console.log(chalk.yellow.bold('\n⚠️  Project files are ready, but dependencies are NOT installed yet.\n'));
    console.log(chalk.white(`   Finish with: ${chalk.cyan(`cd ${folderName} && yarn install`)}\n`));
  }
  console.log(chalk.white(`📁 Project: ${chalk.cyan(folderName)}`));
  console.log(chalk.white(`🔌 Core port: ${chalk.cyan(port)}  ${chalk.gray('(config/core.json)')}`));
  if (yarnInfo?.version) console.log(chalk.white(`📦 Yarn: ${chalk.cyan(yarnInfo.version)}`));
  console.log(chalk.gray('🏠 PM2_HOME: <project>/.pm2/  (isolated daemon — bundled with Loopar)'));

  console.log(chalk.yellow.bold('\n📖 Quick Start:\n'));
  console.log(chalk.white(`  ${chalk.cyan('cd ' + folderName)}`));

  console.log(chalk.white('\n  Control panel (tenant manager TUI):'));
  console.log(chalk.cyan(`    yarn start`));
  console.log(chalk.gray(`    Starts the core if it is down; press q to exit the panel.`));

  console.log(chalk.white('\n  Headless (servers / scripts):'));
  console.log(chalk.cyan(`    yarn serve                  Boot the core (serves every tenant that is on)`));
  console.log(chalk.cyan(`    yarn tenant list            List tenants`));
  console.log(chalk.cyan(`    yarn tenant on|off <name>   Turn a tenant on or off`));

  console.log(chalk.white('\n  Useful commands:'));
  console.log(chalk.cyan(`    yarn stop                   Stop the core (daemon stays alive)`));
  console.log(chalk.cyan(`    yarn restart                Restart the core (re-reads config/core.json)`));
  console.log(chalk.cyan(`    yarn logs                   Tail logs (or press l inside the TUI)`));
  console.log(chalk.cyan(`    yarn kill                   Kill processes + pm2 daemon (clean slate)`));
  console.log(chalk.cyan(`    yarn build && yarn prod     Build and switch the core to production`));

  console.log(chalk.gray('\n🔗 The dev tenant will be available at:'));
  console.log(`  ${chalk.blue.underline(`http://${DEV_DOMAIN}`)}${chalk.gray('        through Caddy (Loopar sets it up on first start)')}`);
  console.log(`  ${chalk.blue.underline(`http://${DEV_DOMAIN}:${port}`)}${chalk.gray('   straight to the core')}`);
  console.log(chalk.gray(`  The core finds the tenant by host name: plain http://localhost:${port} answers "Tenant not identified".`));

  console.log(chalk.gray('\n💡 Tip: dev/prod is one switch for the whole core ([p] in the TUI, or yarn prod).'));
  console.log(chalk.gray('   Tenants are managed from the TUI or from the Desk (Tenant Manager) of the dev tenant.\n'));

  console.log(chalk.gray('📚 Docs: ') + chalk.blue.underline('https://loopar.build'));
  console.log(chalk.gray('💬 Issues: ') + chalk.blue.underline('https://github.com/alphabit-technology/loopar-framework/issues\n'));
}

/**
 * Doctor command
 */
async function runDoctor() {
  console.log(chalk.cyan('\n🔍 Loopar Environment Doctor\n'));
  
  const nodeInfo = checkNodeVersion();
  console.log(chalk.white('Node.js:'), chalk.cyan(nodeInfo.version));
  console.log(chalk.white('Supported:'), nodeInfo.supported
    ? chalk.green('Yes') + chalk.gray('  (the exact requirement is checked against the framework at install)')
    : chalk.red(`No — Loopar needs Node.js ${MIN_NODE_MAJOR}+`));
  console.log();
  
  const hasCorepack = corepackAvailable();
  console.log(chalk.white('Corepack:'), hasCorepack ? chalk.green('Available') : chalk.red('Not found'));
  
  if (hasCorepack) {
    try {
      const corepackVersion = execSync('corepack --version', { stdio: 'pipe', encoding: 'utf8' }).trim();
      console.log(chalk.white('Version:'), chalk.cyan(corepackVersion));
    } catch {}
  }
  console.log();
  
  const yarnInfo = getYarnVersion();
  console.log(chalk.white('Yarn:'), yarnInfo.available ? chalk.green('Available') : chalk.red('Not found'));
  
  if (yarnInfo.available) {
    console.log(chalk.white('Version:'), chalk.cyan(yarnInfo.version));
    console.log(chalk.white('Type:'), yarnInfo.isBerry ? chalk.green('Berry (2.x+)') : chalk.yellow('Classic (1.x)'));
    console.log(chalk.white('Compatible:'), yarnInfo.isCompatible ? chalk.green('Yes') : chalk.red('No'));
    console.log(chalk.white('Compatibility status:'), chalk.cyan(yarnInfo.compatibilityStatus));
  }
  console.log();
  
  const hasGit = gitCliAvailable();
  console.log(chalk.white('Git:'), hasGit ? chalk.green('Available') : chalk.red('Not found'));

  if (hasGit) {
    try {
      const gitVersion = execSync('git --version', { stdio: 'pipe', encoding: 'utf8' }).trim();
      console.log(chalk.white('Version:'), chalk.cyan(gitVersion));
    } catch {}
  }
  console.log();

  // Caddy routes every tenant domain (http://<name>.localhost) to the core.
  // Optional to get started: without it tenants answer on the core port.
  let caddyVersion = null;
  for (const bin of ['caddy', '/opt/homebrew/bin/caddy', '/usr/local/bin/caddy', '/usr/bin/caddy']) {
    try {
      caddyVersion = execSync(`${bin} version`, { stdio: 'pipe', encoding: 'utf8' }).trim().split(/\s+/)[0];
      break;
    } catch { /* try the next location */ }
  }
  console.log(chalk.white('Caddy:'), caddyVersion ? chalk.green('Available') : chalk.yellow('Not found'));
  if (caddyVersion) {
    console.log(chalk.white('Version:'), chalk.cyan(caddyVersion));
  } else {
    console.log(chalk.gray('  Loopar tries to install it on first start (Homebrew on macOS, apt on Debian/Ubuntu).'));
    console.log(chalk.gray('  Other systems: https://caddyserver.com/docs/install'));
    console.log(chalk.gray('  Without Caddy, open tenants on the core port: http://dev.localhost:3000'));
  }
  const port80 = await canBind(80, '0.0.0.0');
  console.log(
    chalk.white('Port 80:'),
    port80 === null ? chalk.green('Free')
      : port80 === 'EADDRINUSE' ? chalk.yellow('In use') + chalk.gray('  (fine if it is Caddy; otherwise Loopar uses a high port in development)')
      : port80 === 'EACCES' ? chalk.yellow('Not allowed for this user') + chalk.gray('  (development falls back to a high port)')
      : chalk.yellow(port80)
  );
  console.log();

  console.log(chalk.yellow('📋 Status:\n'));
  
  if (!nodeInfo.supported) {
    console.log(chalk.red(`❌ Upgrade Node.js to ${MIN_NODE_MAJOR} or higher`));
    console.log(chalk.gray('   https://nodejs.org/\n'));
  } else if (!hasCorepack) {
    console.log(chalk.yellow('⚠️  Corepack not available\n'));
  } else if (!yarnInfo.available) {
    console.log(chalk.yellow('⚠️  Yarn not installed'));
    console.log(chalk.gray(`   Run: corepack prepare yarn@${RECOMMENDED_YARN_VERSION} --activate\n`));
  } else if (!yarnInfo.isCompatible) {
    switch (yarnInfo.compatibilityStatus) {
      case 'too-old-major':
        console.log(chalk.red(`❌ Yarn too old (${yarnInfo.version})`));
        console.log(chalk.gray('   Required: 4.x.x'));
        console.log(chalk.gray(`   Fix: corepack prepare yarn@${RECOMMENDED_YARN_VERSION} --activate`));
        console.log(chalk.gray('   Then close and reopen terminal\n'));
        break;
      case 'too-new-major':
        console.log(chalk.red(`❌ Unsupported newer Yarn major (${yarnInfo.version})`));
        console.log(chalk.gray('   Required: 4.x.x'));
        console.log(chalk.gray(`   Fix: corepack prepare yarn@${RECOMMENDED_YARN_VERSION} --activate`));
        console.log(chalk.gray('   Then close and reopen terminal\n'));
        break;
      default:
        console.log(chalk.red(`❌ Wrong Yarn version (${yarnInfo.version})`));
        console.log(chalk.gray(`   Fix: corepack prepare yarn@${RECOMMENDED_YARN_VERSION} --activate`));
        console.log(chalk.gray('   Then close and reopen terminal\n'));
    }
  } else if (!hasGit) {
    console.log(chalk.yellow('⚠️  Git not found'));
    console.log(chalk.gray('   Install: https://git-scm.com/\n'));
  } else {
    console.log(chalk.green('✅ All systems ready!\n'));
    console.log(chalk.white('Create Loopar projects:'));
    console.log(chalk.cyan('  npx loopar-install my-project\n'));
  }
}

/**
 * Main CLI
 */
program
  .name('loopar-install')
  .description('Create a new Loopar project (Node 22+, Git, Yarn 4.x via Corepack)')
  .version(getCliVersion())
  .showHelpAfterError()
  .configureHelp({ sortSubcommands: true });

program.addHelpText(
  'after',
  `
${chalk.gray('Examples:')}
  ${chalk.cyan('npx loopar-install my-app')}
  ${chalk.cyan('npx loopar-install my-app -p 8080 --yes --skip-start')}
  ${chalk.cyan('loopar-install my-app --source ../loopar --yes --skip-start')}
  ${chalk.cyan('loopar-install doctor')}
`
);

// Main install command
program
  .argument('[folderName]', 'Project folder name (letters, numbers, - and _)')
  .option('-p, --port <number>', 'HTTP port (1024–65535); omit to be prompted')
  .option('-y, --yes', 'Non-interactive: defaults, auto Yarn/Corepack fix, no prompts')
  .option('-q, --quiet', 'Minimal banner')
  .option('-v, --verbose', 'Print stack traces on errors')
  .option('--skip-install', 'Skip dependency installation')
  .option('--skip-start', 'Do not open the tenant manager after install')
  .option('--production', '(deprecated, ignored) dev/prod is a core switch: use `yarn prod` after `yarn build`')
  .option(
    '--source <path>',
    'Copy from a local Loopar checkout instead of cloning from git (for testing the installer against an in-progress branch)'
  )
  .action(async (folderName, options) => {
    try {
      if (options.verbose) {
        process.env.DEBUG = '1';
      }

      assertSupportedNode();
      printBanner(options.quiet);

      if (options.production) {
        console.log(chalk.yellow('⚠️  --production is ignored: dev/prod is a switch of the core (yarn build && yarn prod).\n'));
      }

      // Step 1: What to create, and where — validated before anything on the
      // machine is touched (Corepack, Yarn, the folder).
      const config = await getProjectConfig(folderName, options);

      const cleanFolderName = String(config.folderName).trim();
      const folderValidation = validateFolderName(cleanFolderName);
      if (folderValidation !== true) {
        throw new Error(folderValidation);
      }

      const targetPath = path.resolve(process.cwd(), cleanFolderName);
      const folderExists = fs.existsSync(targetPath);

      if (folderExists && !isLooparProject(targetPath)) {
        throw new Error(
          `${targetPath} already exists and is not a Loopar project.\n` +
          `Choose another folder name, or remove that folder first.`
        );
      }
      if (!folderExists && !options.source && !gitCliAvailable()) {
        throw new Error('git CLI not found. Install Git: https://git-scm.com/downloads');
      }

      // Step 2: Yarn — only when this run is going to use it.
      const needsYarn = !options.skipInstall || config.autoStart;
      const yarnInfo = needsYarn
        ? await ensureYarnVersion({ yes: options.yes })
        : { success: true, version: getYarnVersion().version };

      // Step 3: Clone, copy from local --source, or use the existing project
      if (folderExists) {
        console.log(chalk.yellow(`\n⚠️  Loopar project already exists: ${chalk.cyan(targetPath)}`));
        if (options.source) {
          console.log(chalk.yellow('  (--source ignored; using existing folder contents)'));
        }

        if (!options.yes) {
          const { continueAnyway } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'continueAnyway',
              message: 'Continue with the existing project?',
              default: true
            }
          ]);

          if (!continueAnyway) {
            console.log(chalk.gray('\nCancelled.\n'));
            process.exit(0);
          }
        }

        console.log(chalk.gray('Using existing files...\n'));
      } else if (options.source) {
        console.log();
        await copyFromLocal(options.source, targetPath);
        console.log();
      } else {
        console.log();
        await cloneRepo(DEFAULT_REPO, targetPath);
        console.log();
      }

      // Step 4: The Node version this framework version asks for
      assertFrameworkNode(targetPath);

      // Step 5: Fix Yarn configuration
      await cleanYarnConfig(targetPath);
      await fixPackageManager(targetPath);
      console.log();

      // Step 6: The core's port — checked free, then saved to config/core.json
      const port = persistCorePort(targetPath, await findAvailablePort(config.port));

      // Step 7: Install
      let installed = fs.existsSync(path.join(targetPath, 'node_modules', 'loopar'));
      if (!options.skipInstall) {
        installed = await installDependencies(targetPath, yarnInfo, {
          yes: options.yes,
          port
        });
      } else {
        console.log(chalk.gray('⏭️  Skipped installation\n'));
      }

      // Step 8: Closing message
      printSuccessMessage(cleanFolderName, port, yarnInfo, { installed });

      // Step 9: Open the tenant manager — only over an installed project
      if (config.autoStart && installed) {
        await startTenantManager(targetPath, port);
      } else {
        console.log(chalk.gray(installed ? '💡 To start:' : '💡 After installing dependencies:'));
        console.log(chalk.cyan(`   cd ${cleanFolderName}`));
        console.log(chalk.cyan(`   yarn start    # Opens the tenant manager (TUI)\n`));
      }

    } catch (error) {
      console.error(chalk.red('\n❌ Error:'), error.message);
      if (process.env.DEBUG) {
        console.error(chalk.gray(error.stack));
      }
      process.exit(1);
    }
  });

// Doctor command
program
  .command('doctor')
  .description('Check environment and diagnose issues')
  .action(runDoctor);

program.parse(process.argv);