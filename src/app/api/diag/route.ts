import { NextResponse } from 'next/server';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

function listDir(dir: string): string[] | string {
  try {
    if (!fs.existsSync(dir)) return 'MISSING';
    return fs.readdirSync(dir).slice(0, 25);
  } catch (error) {
    return `ERR: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// Temporary diagnostic endpoint: verifies sharp's native module presence at
// runtime on Vercel. Remove after the sharp packaging issue is resolved.
export async function GET() {
  const out: Record<string, unknown> = {};

  for (const pkg of ['sharp', '@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64']) {
    try {
      // Resolve the package.json to locate the package root without importing
      // any native code (avoids Turbopack bundling the .node addon).
      const pkgPath = require.resolve(`${pkg}/package.json`);
      const root = path.dirname(pkgPath);
      const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      out[pkg] = {
        root,
        version: pkgJson.version,
        files: listDir(root),
        libDir: listDir(path.join(root, 'lib')),
      };
    } catch (error) {
      out[pkg] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return NextResponse.json(out);
}
