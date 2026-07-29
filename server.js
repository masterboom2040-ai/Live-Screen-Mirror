import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const nodeModulesDir = path.join(__dirname, 'node_modules');
const compiledServer = path.join(__dirname, 'dist', 'server.cjs');

if (!existsSync(compiledServer)) {
  console.log('⚠️  Production build not found in dist/ directory.');

  if (!existsSync(nodeModulesDir)) {
    console.error('\n❌ Missing node_modules! Dependencies have not been installed yet.');
    console.error('\nPlease run the following command once in your terminal first:');
    console.error('   npm install\n');
    console.error('Then run:');
    console.error('   npm run build');
    console.error('   node server.js\n');
    process.exit(1);
  }

  console.log('Building project now...');
  try {
    execSync('npm run build', { stdio: 'inherit' });
  } catch (e) {
    console.error('\n❌ Build failed. Please ensure all packages are installed by running: npm install');
    process.exit(1);
  }
}

if (!existsSync(compiledServer)) {
  console.error('\n❌ Could not find dist/server.cjs after build. Please run "npm run build" manually.');
  process.exit(1);
}

console.log('🚀 Starting Presenter Studio server on http://localhost:3000 ...');
await import('./dist/server.cjs');

