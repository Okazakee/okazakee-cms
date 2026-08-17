import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const verifyTypeScriptPath = path.join(
  process.cwd(),
  'node_modules',
  'next',
  'dist',
  'lib',
  'verify-typescript-setup.js'
);

const typeScriptFileNeedle = "file: 'typescript/lib/typescript.js',";
const typeScriptFileReplacement = "file: 'typescript/lib/version.cjs',";

const typeCheckNeedle = `        let result;
        if (shouldRunTypeCheck) {
            const { runTypeCheck } = require('./typescript/runTypeCheck');
            // Install native bindings so that code frame rendering works in the worker
            const { installBindings } = require('../build/swc/install-bindings');
            await installBindings();
            const tsPath = deps.resolved.get('typescript');
            const typescript = await Promise.resolve(require(tsPath));
            // Verify the project passes type-checking before we go to webpack phase:
            result = await runTypeCheck(typescript, dir, distDir, resolvedTsConfigPath, cacheDir, hasAppDir, {
                app: appDir,
                pages: pagesDir
            }, debugBuildPaths);
        }`;

const typeCheckReplacement = `        let result;
        const shouldRunNextTypeCheck = shouldRunTypeCheck && !typescriptVersion.startsWith('7.');
        if (shouldRunNextTypeCheck) {
            const { runTypeCheck } = require('./typescript/runTypeCheck');
            // Install native bindings so that code frame rendering works in the worker
            const { installBindings } = require('../build/swc/install-bindings');
            await installBindings();
            const tsPath = deps.resolved.get('typescript');
            const typescript = await Promise.resolve(require(tsPath));
            // Verify the project passes type-checking before we go to webpack phase:
            result = await runTypeCheck(typescript, dir, distDir, resolvedTsConfigPath, cacheDir, hasAppDir, {
                app: appDir,
                pages: pagesDir
            }, debugBuildPaths);
        } else if (shouldRunTypeCheck) {
            _log.info('Skipping Next.js internal type check for TypeScript 7; run tsc separately.');
        }`;

async function patchVerifyTypeScriptSetup() {
  const source = await readFile(verifyTypeScriptPath, 'utf8');

  let patched = source;

  if (patched.includes(typeScriptFileNeedle)) {
    patched = patched.replace(typeScriptFileNeedle, typeScriptFileReplacement);
  }

  if (patched.includes(typeCheckNeedle)) {
    patched = patched.replace(typeCheckNeedle, typeCheckReplacement);
  }

  if (patched !== source) {
    await writeFile(verifyTypeScriptPath, patched);
  }
}

await patchVerifyTypeScriptSetup();
