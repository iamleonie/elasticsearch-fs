import path from 'node:path/posix';

/** Normalises backslashes to forward slashes, collapses repeated slashes, and strips a leading `./` and any trailing slashes. */
function normalizeSlashesAndDots(input: string): string {
  return input
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/g, "");
}

/*
 * Normalize a slug to a relative slug.
 */
export function normalizeSlug(slug: string): string {
  const normalized = normalizeSlashesAndDots(slug);
  const absolute = normalized === '' ? '/' : normalized.startsWith('/') ? normalized : `/${normalized}`;
  if (absolute === '/') {
    throw new Error('Invalid slug: empty string.');
  }
  return absolute.slice(1);
}

/**
 * Normalize to a generic absolute path.
 */
export function normalizePath(filePath: string): string {
  const normalized = normalizeSlashesAndDots(filePath);
  return normalized === '' ? '/' : normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/**
 * Convert an .mdx path back to its slug.
 * "/blog/hello.mdx"   -> "blog/hello"
 */
export function pathToSlug(filePath: string): string {
  const normalized = normalizePath(filePath);
  if (!normalized.endsWith('.mdx')) {
    throw new Error(`Path must end with .mdx: "${filePath}"`);
  }
  return normalized.slice(1, -'.mdx'.length);
}

/**
 * Convert a slug to its corresponding absolute .mdx path.
 * "blog/hello" -> "/blog/hello.mdx"
 */
export function slugToPath(slug: string): string {
  const normalizedSlug = normalizeSlug(slug);
  return normalizedSlug.endsWith('.mdx')
    ? `/${normalizedSlug}`
    : `/${normalizedSlug}.mdx`;
}

/**
 * Builds an in-memory file tree from a collection of slugs.
 * Returns a `files` set of absolute `.mdx` paths and a `dirs` map of directory path → sorted child names,
 * with intermediate parent directories synthesised automatically.
 */
export function buildFileTreeFromSlugs(slugs: Iterable<string>): {
  files: Set<string>;
  dirs: Map<string, string[]>;
} {
  const files = new Set<string>();
  const dirToChildren = new Map<string, Set<string>>();

  function addChild(dir: string, name: string): void {
    const d = dir === '' ? '/' : normalizePath(dir);
    let set = dirToChildren.get(d);
    if (!set) {
      set = new Set();
      dirToChildren.set(d, set);
    }
    set.add(name);
  }

  for (const rawSlug of slugs) {
    const fp = slugToPath(rawSlug);
    files.add(fp);

    const base = path.basename(fp);
    let dir = path.dirname(fp);

    if (dir === '.') dir = '/';
    addChild(dir, base);

    let current = dir;
    while (current !== '/' && current !== '') {
      const parent = path.dirname(current);
      const seg = path.basename(current);
      const p = parent === '' || parent === '.' ? '/' : parent;
      addChild(p, seg);
      current = p;
    }
  }

  const dirs = new Map<string, string[]>();
  for (const [d, children] of dirToChildren) {
    dirs.set(d, [...children].sort());
  }

  return { files, dirs };
}
