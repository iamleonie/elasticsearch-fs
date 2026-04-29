/**
 * `just-bash` declares these on `dist/fs/interface` but does not re-export them from the package
 * root (`index.d.ts`). Keep shapes aligned when bumping `just-bash`.
 */
import type { BufferEncoding } from 'just-bash';

export interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

export interface WriteFileOptions {
  encoding?: BufferEncoding;
}

export interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
