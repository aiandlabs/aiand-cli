import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { agentHome, pathIsInside } from "../fsutil.js";

/**
 * The bare-repo dotfiles setup (`git --git-dir=~/.dotfiles --work-tree=~`)
 * leaves no `.git` anywhere above the config files it tracks, so the walk
 * up for one never finds it. The repository is a directory directly in HOME
 * instead, and what it tracks is named by its own `core.worktree`, or, when
 * the work tree only ever rides on the command line, implied by an `index`
 * file: a bare repository has none until something is added through an
 * external work tree.
 */

/** A git directory, by what git itself needs to see: HEAD, objects/ and refs/. */
async function isGitDir(dir: string): Promise<boolean> {
  if (!existsSync(join(dir, "HEAD"))) return false;
  const [objects, refs] = await Promise.all([
    stat(join(dir, "objects")).catch(() => null),
    stat(join(dir, "refs")).catch(() => null),
  ]);
  return objects?.isDirectory() === true && refs?.isDirectory() === true;
}

/** `core.worktree` from a git config file's text, unquoted; undefined when unset. */
function coreWorktree(config: string): string | undefined {
  let inCore = false;
  let found: string | undefined;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]*)\]/.exec(line);
    if (section) {
      inCore = section[1]?.trim().toLowerCase() === "core";
      continue;
    }
    if (!inCore) continue;
    const value = /^\s*worktree\s*=\s*(.*?)\s*$/i.exec(line)?.[1];
    if (value !== undefined) found = value.replace(/^"(.*)"$/, "$1");
  }
  return found;
}

async function resolveWorktree(gitDir: string, config: string): Promise<string | null> {
  const declared = coreWorktree(config);
  let tree: string;
  if (declared !== undefined) {
    tree = declared.startsWith("~/") ? join(agentHome(), declared.slice(2)) : declared;
    tree = resolve(gitDir, tree);
  } else if (existsSync(join(gitDir, "index"))) {
    tree = agentHome();
  } else {
    return null;
  }
  return realpath(tree).catch(() => resolve(tree));
}

/**
 * The bare-style repository directly in HOME whose work tree covers `real`,
 * or null. Reads files only: git is never spawned.
 */
export async function dotfilesRepoFor(real: string): Promise<string | null> {
  const home = agentHome();
  let names: string[];
  try {
    names = await readdir(home);
  } catch {
    return null;
  }
  for (const name of names) {
    const gitDir = join(home, name);
    if (!(await isGitDir(gitDir))) continue;
    const config = await readFile(join(gitDir, "config"), "utf8").catch(() => "");
    const tree = await resolveWorktree(gitDir, config);
    if (tree !== null && pathIsInside(tree, real)) return gitDir;
  }
  return null;
}
