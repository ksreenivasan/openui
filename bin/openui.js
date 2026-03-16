#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const PORT = process.env.PORT || 6969;

console.log(`
  ██████╗ ██████╗ ███████╗███╗   ██╗██╗   ██╗██╗
 ██╔═══██╗██╔══██╗██╔════╝████╗  ██║██║   ██║██║
 ██║   ██║██████╔╝█████╗  ██╔██╗ ██║██║   ██║██║
 ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║   ██║██║
 ╚██████╔╝██║     ███████╗██║ ╚████║╚██████╔╝██║
  ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝
`);

console.log(`Starting OpenUI on http://localhost:${PORT}`);
console.log('Press Ctrl+C to stop\n');

// Start the server
const server = spawn('node', ['server/index.js'], {
  cwd: rootDir,
  stdio: 'inherit',
  env: { ...process.env, PORT }
});

// Open browser after a short delay
setTimeout(() => {
  open(`http://localhost:${PORT}`);
}, 1500);

// Handle process termination
process.on('SIGINT', () => {
  server.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.kill();
  process.exit(0);
});
