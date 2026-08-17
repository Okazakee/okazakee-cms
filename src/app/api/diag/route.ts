import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

function listDir(dir: string): string[] | string {
  try {
    if (!fs.existsSync(dir)) return 'MISSING';
    return fs.readdirSync(dir).slice(0, 30);
  } catch (error) {
    return `ERR: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// Temporary diagnostic endpoint: verifies sharp's native module presence at
// runtime on Vercel. Remove after the sharp packaging issue is resolved.
export async function GET() {
  const cwd = process.cwd();
  const nm = path.join(cwd, 'node_modules');

  const out: Record<string, unknown> = {
    cwd,
    nodeModules: listDir(nm),
    imgDir: listDir(path.join(nm, '@img')),
    sharpDir: listDir(path.join(nm, 'sharp')),
  };

  for (const pkg of ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64']) {
    const root = path.join(nm, pkg);
    out[pkg] = {
      root,
      files: listDir(root),
      libFiles: listDir(path.join(root, 'lib')),
    };
  }

  return NextResponse.json(out);
}
