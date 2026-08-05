import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await cp(join(root, 'tienlen', 'public'), dist, { recursive: true });
await cp(join(root, 'poki', 'public'), join(dist, 'poki'), { recursive: true });
console.log('Built Tiến Lên + Poki into dist');
