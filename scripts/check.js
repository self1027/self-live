const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');
function check(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') check(file);
    else if (file.endsWith('.js')) {
      const args = file.includes('renderer') ? ['--input-type=module', '--check'] : ['--check', file];
      const result = spawnSync(process.execPath, args, { stdio: file.includes('renderer') ? ['pipe', 'inherit', 'inherit'] : 'inherit', input: file.includes('renderer') ? require('node:fs').readFileSync(file) : undefined });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
check('src'); check('test'); check('scripts'); check('relay'); console.log('Sintaxe validada.');
