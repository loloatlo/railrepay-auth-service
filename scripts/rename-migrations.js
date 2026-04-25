#!/usr/bin/env node
/**
 * Post-Build Script: Rename Migration Files from .js to .cjs
 *
 * Purpose:
 * - Resolves ESM/CommonJS conflict in Railway deployments.
 * - package.json has "type": "module" (ESM).
 * - Migrations are compiled to CommonJS (tsconfig.migrations.json sets module=CommonJS).
 * - node-pg-migrate uses require() which needs CommonJS.
 *
 * Solution:
 * - Rename compiled migration .js files to .cjs extension after build.
 * - CommonJS modules with .cjs extension work correctly in ESM packages.
 *
 * ADR Reference:
 * - ADR-003: node-pg-migrate for database migrations
 */

import { readdir, rename } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = join(__dirname, '..', 'dist', 'migrations');

async function renameMigrations() {
  try {
    const files = await readdir(MIGRATIONS_DIR);
    const jsFiles = files.filter((file) => file.endsWith('.js'));

    if (jsFiles.length === 0) {
      console.log('No .js migration files found to rename.');
      return;
    }

    for (const file of jsFiles) {
      const oldPath = join(MIGRATIONS_DIR, file);
      const newPath = join(MIGRATIONS_DIR, file.replace(/\.js$/, '.cjs'));
      await rename(oldPath, newPath);
      console.log(`Renamed: ${file} -> ${file.replace(/\.js$/, '.cjs')}`);
    }

    console.log(`Successfully renamed ${jsFiles.length} migration file(s) to .cjs`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('Error: dist/migrations directory not found. Run build:migrations first.');
      process.exit(1);
    }
    throw error;
  }
}

renameMigrations().catch((error) => {
  console.error('Failed to rename migration files:', error);
  process.exit(1);
});
