const fs = require('fs');
const path = require('path');

const wwwDir = path.join(__dirname, '..', 'www');
fs.mkdirSync(wwwDir, { recursive: true });
console.log('Capacitor www ready (WebView lädt /map vom Server).');
