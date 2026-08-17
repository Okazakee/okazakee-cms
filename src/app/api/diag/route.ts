import { NextResponse } from 'next/server';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

function listDir(dir: string): string[] | string {
  try {
    if (!fs.existsSync(dir)) return 'MISSING';
    return fs.readdirSync(dir).slice(0, 20);
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
      const resolved = require.resolve(pkg);
      const root = path.dirname(resolved);
      const pkgJson = JSON.parse(
        fs.readFileSync(path.join(root, 'package.json'), 'utf8')
      );
      out[pkg] = {
        resolved,
        version: pkgJson.version,
        files: listDir(root),
      };
    } catch (error) {
      out[pkg] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  try {
    const sharp = require('sharp');
    const meta = await sharp(Buffer.from('fake')).metadata();
    out.loadTest = `loaded, metadata error: ${String(meta)}`;
  } catch (error) {
    out.loadTest = `LOAD FAILED: ${error instanceof Error ? error.message : String(error)}`;
  }

  return NextResponse.json(out);
}
