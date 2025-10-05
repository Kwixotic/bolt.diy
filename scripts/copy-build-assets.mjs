import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const clientBuildDir = path.resolve('build', 'client');
  const publicBuildDir = path.resolve('public', 'build');

  try {
    await stat(clientBuildDir);
  } catch (error) {
    console.warn('Client build directory not found, skipping asset copy.');
    return;
  }

  await rm(publicBuildDir, { recursive: true, force: true });
  await mkdir(publicBuildDir, { recursive: true });
  await cp(clientBuildDir, publicBuildDir, { recursive: true });

  console.log('Copied client assets to public/build for Vercel deployment.');
}

main().catch((error) => {
  console.error('Failed to copy build assets', error);
  process.exit(1);
});
