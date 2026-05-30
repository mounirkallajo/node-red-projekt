const fs = require('fs');
const path = require('path');

const projectDirectory = __dirname;
const flowFilePath = path.join(projectDirectory, 'flows.json');
const mapLogikFilePath = path.join(projectDirectory, 'Maplogik');
const mapLogikTemplateNodeId = 'b0dbf8a4e58a40b2';
const cameraPanelNodeId = '02cf7abe132e485f';

const flowContent = JSON.parse(fs.readFileSync(flowFilePath, 'utf8'));
const mapLogikContent = fs.readFileSync(mapLogikFilePath, 'utf8');

const templateNode = flowContent.find(function (flowNode) {
  return flowNode && flowNode.id === mapLogikTemplateNodeId;
});

if (!templateNode) {
  console.error('Template node with id ' + mapLogikTemplateNodeId + ' not found in flows.json');
  process.exit(1);
}

templateNode.template = mapLogikContent;

const cameraPanelFilePath = path.join(projectDirectory, 'camera-panel.js');
const cameraPanelNode = flowContent.find(function (flowNode) {
  return flowNode && flowNode.id === cameraPanelNodeId;
});
if (cameraPanelNode && fs.existsSync(cameraPanelFilePath)) {
  const cameraPanelSource = fs.readFileSync(cameraPanelFilePath, 'utf8');
  // camera-panel.js ist bereits ein vollstaendiger Node-RED-Function-Body
  // (setzt msg.headers/msg.payload und endet mit "return msg;"). Daher direkt
  // zuweisen statt erneut einzuwickeln - sonst landet das innere "return msg;"
  // als Top-Level im Browser-Payload (Illegal return statement).
  cameraPanelNode.func = cameraPanelSource;
  console.log('flows.json synchronised with camera-panel.js (' + cameraPanelSource.length + ' chars)');
}

fs.writeFileSync(flowFilePath, JSON.stringify(flowContent, null, 4), 'utf8');
console.log('flows.json synchronised with Maplogik content (' + mapLogikContent.length + ' chars)');
