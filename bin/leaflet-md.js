#!/usr/bin/env node
// `leaflet-md` command, installed by `npm install -g leaflet-md-opener`.
// It is a thin wrapper: all the real work happens in the PowerShell scripts,
// so the npm install and the git-clone install behave identically.

'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const WINDOW_MODES = ['fullscreen', 'maximized', 'tab'];

const HELP = `Leaflet ${VERSION} - read and edit Markdown files

Usage:
  leaflet-md <file.md>              Open a file (or a folder)
  leaflet-md <file.md> --window tab Open it as a browser tab instead of full screen
  leaflet-md install                Register Leaflet for .md files (Open with)
  leaflet-md install --window maximized
  leaflet-md uninstall              Remove the registration
  leaflet-md uninstall --remove-data  ...and delete saved settings
  leaflet-md --version | --help

Window modes: ${WINDOW_MODES.join(', ')}`;

function powershell(script, args, { wait = true } = {}) {
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, script), ...args];
  if (!wait) {
    spawn('powershell.exe', argv, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return 0;
  }
  return spawnSync('powershell.exe', argv, { stdio: 'inherit' }).status ?? 1;
}

function readWindowOption(args) {
  const i = args.indexOf('--window');
  if (i === -1) return [];
  const mode = args[i + 1];
  if (!WINDOW_MODES.includes(mode)) {
    console.error(`--window must be one of: ${WINDOW_MODES.join(', ')}`);
    process.exit(2);
  }
  return ['-Window', mode];
}

function main(args) {
  if (process.platform !== 'win32') {
    console.error('Leaflet is a Windows tool (it uses PowerShell and Windows file associations).');
    return 1;
  }
  const [command] = args;
  if (!command || command === '--help' || command === '-h') { console.log(HELP); return 0; }
  if (command === '--version' || command === '-v') { console.log(VERSION); return 0; }

  if (command === 'install') {
    return powershell('scripts/install.ps1', [...readWindowOption(args), '-ShowPicker']);
  }
  if (command === 'uninstall') {
    return powershell('scripts/uninstall.ps1', args.includes('--remove-data') ? ['-RemoveData'] : []);
  }

  const target = path.resolve(command);
  if (!fs.existsSync(target)) {
    console.error(`Not found: ${target}`);
    return 1;
  }
  return powershell('src/Leaflet.ps1', ['-Path', target, ...readWindowOption(args)], { wait: false });
}

process.exitCode = main(process.argv.slice(2));
