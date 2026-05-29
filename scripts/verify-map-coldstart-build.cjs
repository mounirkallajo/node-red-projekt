'use strict';

const fs = require('fs');
const path = require('path');

const mapPath = path.join(__dirname, '..', 'Maplogik');
const bridgePath = path.join(__dirname, '..', 'mobile', 'capacitor-bridge.js');

const required = [
  {
    file: mapPath,
    needles: [
      'runColdStartTrackingBootstrap',
      'showAllDevicesOnMap: true',
      'shouldRunClientFailsafeUiForDevice',
      'waitForNativeDeviceKey'
    ],
    forbidden: ['client-debug', '__debugLog', 'mapDebugBuildChip', '127.0.0.1:7479']
  },
  {
    file: bridgePath,
    needles: ['capacitor-gps-point'],
    forbidden: ['127.0.0.1:7479', 'debugFirstPublishLogged']
  }
];

let failed = 0;
for (const check of required) {
  const text = fs.readFileSync(check.file, 'utf8');
  for (const needle of check.needles) {
    if (!text.includes(needle)) {
      console.error('MISSING', needle, 'in', check.file);
      failed += 1;
    }
  }
  for (const needle of check.forbidden || []) {
    if (text.includes(needle)) {
      console.error('FORBIDDEN', needle, 'still in', check.file);
      failed += 1;
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log('OK map cold-start sources');
