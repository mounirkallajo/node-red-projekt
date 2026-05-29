const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const sourceCandidates = [
  path.join(projectRoot, 'mobile-capacitor', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
  path.join(projectRoot, 'mobile-capacitor', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk'),
  path.join(projectRoot, 'mobile-capacitor', 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
];
const targetDir = path.join(projectRoot, 'mobile-releases');
const targetFile = path.join(targetDir, 'mobile-tracking.apk');

const sourceFile = sourceCandidates.find(function (candidatePath) {
  return fs.existsSync(candidatePath);
});

if (!sourceFile) {
  console.error('Keine APK gefunden. Zuerst in Android Studio bauen: Build > Build APK(s).');
  console.error('Erwartet z.B.: mobile-capacitor/android/app/build/outputs/apk/debug/app-debug.apk');
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(sourceFile, targetFile);
const sizeMb = (fs.statSync(targetFile).size / (1024 * 1024)).toFixed(2);
console.log('APK kopiert: ' + targetFile + ' (' + sizeMb + ' MB)');
console.log('Auf dem Pi nach ~/.node-red/mobile-releases/mobile-tracking.apk kopieren und Node-RED deployen.');
