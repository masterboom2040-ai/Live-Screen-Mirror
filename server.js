import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compiledServer = path.join(__dirname, 'dist', 'server.cjs');

if (!existsSync(compiledServer)) {
  console.log('Production bundle not found in dist/. Building project...');
  execSync('npm run build', { stdio: 'inherit' });
}

console.log('Starting Presenter Studio server...');
await import('./dist/server.cjs');
