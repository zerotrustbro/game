import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const source = join(process.cwd(), 'tienlen', 'public');
const target = join(process.cwd(), 'dist');
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`Built Tiến Lên into ${target}`);

const assetRoot = join(target, 'assets');
console.log(`Assets copied from ${assetRoot}`);
