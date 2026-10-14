// Runs after `npm install -g leaflet-md-opener`: registers Leaflet for .md
// files and opens Windows' app picker so the user can make it the default.
//
// Rules this script keeps:
// - It only acts on a *global* install on Windows. As a project dependency
//   (or on CI) it does nothing.
// - It never fails the npm install. Registration is a convenience; if it goes
//   wrong the user can still run `leaflet-md install`.
// - LEAFLET_NO_REGISTER=1 skips it entirely; LEAFLET_NO_PICKER=1 skips the dialog.

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const isGlobal = process.env.npm_config_global === 'true' || process.env.npm_config_location === 'global';
const env = process.env;

function run() {
  if (process.platform !== 'win32' || !isGlobal || env.CI || env.LEAFLET_NO_REGISTER === '1') return;

  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'scripts', 'install.ps1')];
  if (env.LEAFLET_NO_PICKER !== '1') args.push('-ShowPicker');

  const result = spawnSync('powershell.exe', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.warn('\nLeaflet installed, but registering it for .md files failed. Run: leaflet-md install');
  }
}

try {
  run();
} catch (err) {
  console.warn(`\nLeaflet installed, but setup was skipped (${err.message}). Run: leaflet-md install`);
}
