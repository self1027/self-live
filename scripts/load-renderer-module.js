// Carrega módulos de navegador nos unit tests sem mudar o package.json para ESM.
const fs = require('node:fs');
const path = require('node:path');
function moduleUrl(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/from '(\.\/[^']+)'/g,
    (_match, dependency) => `from '${moduleUrl(path.resolve(path.dirname(file), dependency))}'`);
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}
module.exports = name => import(moduleUrl(path.join(__dirname, '../src/renderer', name)));
