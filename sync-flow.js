const fs = require('fs');
const path = require('path');

const projectDirectory = __dirname;
const flowFilePath = path.join(projectDirectory, 'flow.json');
const mapLogikFilePath = path.join(projectDirectory, 'Maplogik');
const mapLogikTemplateNodeId = 'b0dbf8a4e58a40b2';

const flowContent = JSON.parse(fs.readFileSync(flowFilePath, 'utf8'));
const mapLogikContent = fs.readFileSync(mapLogikFilePath, 'utf8');

const templateNode = flowContent.find(function (flowNode) {
  return flowNode && flowNode.id === mapLogikTemplateNodeId;
});

if (!templateNode) {
  console.error('Template node with id ' + mapLogikTemplateNodeId + ' not found in flow.json');
  process.exit(1);
}

templateNode.template = mapLogikContent;

fs.writeFileSync(flowFilePath, JSON.stringify(flowContent, null, 4), 'utf8');
console.log('flow.json synchronised with Maplogik content (' + mapLogikContent.length + ' chars)');
