import { readFile } from "node:fs/promises";
import { normalizeSlug } from "../core/path-tree.js";

export type JsonObject = Record<string, unknown>;

type PathTreeEntry = {
  isPublic: boolean;
  groups: string[];
};

export type PathTreePolicy = Record<string, PathTreeEntry>;

export type CompiledAccessPlan = {
  publicSlugs: string[];
  groupSlugs: Record<string, string[]>;
};

/** Strips trailing commas before object/array closers, then parses as JSON. Allows lax JSON that editors commonly produce. */
function parseJsonWithTrailingCommaSupport(raw: string): unknown {
  const sanitized = raw.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(sanitized) as unknown;
}

/** Validates and coerces a raw JSON value into a `PathTreeEntry`. Throws a descriptive error if `isPublic` or `groups` have the wrong shape. */
function asPathTreeEntry(value: unknown, slug: string): PathTreeEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid path tree entry for "${slug}": expected object.`);
  }
  const obj = value as JsonObject;
  if (typeof obj.isPublic !== "boolean") {
    throw new Error(`Invalid path tree entry for "${slug}": "isPublic" must be boolean.`);
  }
  if (!Array.isArray(obj.groups) || obj.groups.some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid path tree entry for "${slug}": "groups" must be string[].`);
  }
  const groups = obj.groups.map((group) => group.trim()).filter(Boolean);
  return { isPublic: obj.isPublic, groups: [...new Set(groups)].sort() };
}

/** Reads a JSON file from disk and parses it as a `PathTreePolicy`. Accepts trailing commas. */
export async function loadPathTreeAccessPolicy(path: string): Promise<PathTreePolicy> {
  const raw = await readFile(path, "utf8");
  const parsed = parseJsonWithTrailingCommaSupport(raw);
  return parsePathTreeAccessPolicy(parsed);
}

/** Validates a parsed JSON value as a `PathTreePolicy`, normalising each slug via `normalizeSlug`. */
export function parsePathTreeAccessPolicy(parsed: unknown): PathTreePolicy {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Path tree policy must be an object.");
  }

  const out: PathTreePolicy = {};
  for (const [rawSlug, value] of Object.entries(parsed as JsonObject)) {
    const slug = normalizeSlug(rawSlug);
    out[slug] = asPathTreeEntry(value, slug);
  }
  return out;
}

/**
 * Derives per-profile slug assignments from a `PathTreePolicy`.
 * Each group slug list is the union of group slugs and all public slugs,
 * so a group profile can always read public content.
 */
export function compileAccessPlanFromPolicy(
  policy: PathTreePolicy,
): CompiledAccessPlan {
  const publicSet = new Set<string>();
  const groupSets = new Map<string, Set<string>>();

  for (const [slug, entry] of Object.entries(policy)) {
    if (entry.isPublic) {
      publicSet.add(slug);
    }
    for (const group of entry.groups) {
      let set = groupSets.get(group);
      if (!set) {
        set = new Set<string>();
        groupSets.set(group, set);
      }
      set.add(slug);
    }
  }

  const publicSlugs = [...publicSet].sort();
  const groupSlugs: Record<string, string[]> = {};
  for (const [group, slugs] of groupSets) {
    const merged = new Set<string>(publicSet);
    for (const slug of slugs) merged.add(slug);
    groupSlugs[group] = [...merged].sort();
  }

  return { publicSlugs, groupSlugs };
}
