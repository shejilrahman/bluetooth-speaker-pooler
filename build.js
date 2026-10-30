'use strict';
/*
 * Builds dist/SpeakerQueue.exe: a single executable containing Node, server.js
 * and the web pages (Node "single executable application").
 *
 *   node build.js
 *
 * Needs Node >= 20 and internet once (downloads the `postject` helper via npx).
 * The exe still needs VLC on the target PC; it installs VLC with winget and
 * downloads yt-dlp by itself on first run.
 *
 * The hub address the exe joins by default comes from hub-default.json
 * (override with BUILD_HUB_URL=wss://.../agent). Only the URL is embedded,
 * never a room key.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const EXE = path.join(DIST, 'SpeakerQueue.exe');
const BLOB = path.join(ROOT, 'sea-prep.blob');
const CFG = path.join(ROOT, 'sea-config.json');
const HUB_ASSET = path.join(ROOT, 'sea-hub-default.json');

fs.mkdirSync(DIST, { recursive: true });

// 1. config: main script + embedded assets (served by server.js via sea.getAsset)
const assets = {};
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) assets[f] = path.join('public', f).replace(/\\/g, '/');
assets['bluetooth.ps1'] = 'bluetooth.ps1';
let hubUrl = process.env.BUILD_HUB_URL || '';
if (!hubUrl) { try { hubUrl = JSON.parse(fs.readFileSync(path.join(ROOT, 'hub-default.json'), 'utf8')).hubUrl || ''; } catch (_) { /* none */ } }
hubUrl = String(hubUrl).trim();
if (hubUrl && !/^wss?:\/\//.test(hubUrl)) throw new Error('default hub URL must start with ws:// or wss://: ' + hubUrl);
console.log('default hub: ' + (hubUrl || '(none, hosts set it in config.json)'));
fs.writeFileSync(HUB_ASSET, JSON.stringify({ hubUrl }));
assets['hub-default.json'] = 'sea-hub-default.json';
fs.writeFileSync(CFG, JSON.stringify({
  main: 'server.js',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
  assets,
}, null, 2));

// 2. blob
console.log('[1/3] generating blob...');
execFileSync(process.execPath, ['--experimental-sea-config', CFG], { stdio: 'inherit', cwd: ROOT });

// 3. copy node.exe and inject
console.log('[2/3] copying node runtime...');
fs.copyFileSync(process.execPath, EXE);
console.log('[3/3] injecting blob (postject)...');
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
  // relative paths: the folder name may contain spaces, which the shell would split
  ['-y', 'postject', 'dist/SpeakerQueue.exe', 'NODE_SEA_BLOB', 'sea-prep.blob', '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
  { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32' });

// hub gets its own copy of the web pages so the hub folder deploys on its own
const HUB_PUBLIC = path.join(ROOT, 'hub', 'public');
fs.mkdirSync(HUB_PUBLIC, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'public'))) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(HUB_PUBLIC, f));

// extras for the dist folder
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(DIST, 'README.md'));
fs.copyFileSync(path.join(ROOT, 'allow-firewall.bat'), path.join(DIST, 'allow-firewall.bat'));
fs.copyFileSync(path.join(ROOT, 'enable-autologin.bat'), path.join(DIST, 'enable-autologin.bat'));
fs.writeFileSync(path.join(DIST, 'Remove from Startup.bat'), '@echo off\r\n"%~dp0SpeakerQueue.exe" --remove-autostart\r\npause\r\n');
fs.unlinkSync(BLOB);
fs.unlinkSync(CFG);
fs.unlinkSync(HUB_ASSET);

const mb = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
console.log(`\nDone: ${EXE} (${mb} MB)\nCopy the dist folder to the new PC and double-click SpeakerQueue.exe.`);
