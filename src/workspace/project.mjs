import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';
import { view, entry, control } from './view.mjs';
const exec = promisify(execFile);

/** Git is invoked directly, in the pinned project root, never through a shell or user-provided arguments. */
export async function projectInfo(root) {
  const run = async args => (await exec('git', ['-C', root, ...args], { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } })).stdout;
  const result = { valid: await realpath(root).then(p => p === root, () => false), branch: null, worktrees: [], repository: false };
  if (!result.valid) return result;
  try {
    const top = (await run(['rev-parse', '--show-toplevel'])).trim();
    if (await realpath(top) !== root) return result; // An authorized subdirectory must not enumerate its parent repository.
    result.repository = true;
    result.branch = (await run(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || null;
  } catch { /* Detached HEAD, missing Git or non-repository: do not fabricate a branch. */ }
  if (result.repository) {
    try {
      const raw = await run(['worktree', 'list', '--porcelain', '-z']); let current;
      for (const value of raw.split('\0')) {
        if (value.startsWith('worktree ')) { current = { path: value.slice(9), branch: null, detached: false, locked: false }; result.worktrees.push(current); }
        else if (current && value.startsWith('branch ')) current.branch = value.slice(7);
        else if (current && value === 'detached') current.detached = true;
        else if (current && (value === 'locked' || value.startsWith('locked '))) current.locked = true;
      }
    } catch { /* Worktree details are optional native data, not a reason to fabricate isolation. */ }
  }
  return result;
}
export async function projectView(root, projects) {
  const info = await projectInfo(root);
  const entries = [entry('Project root', info.valid ? 'Authorized root identity is valid' : 'Root is unavailable', { state: info.valid ? 'valid' : 'invalid' }), entry('Git branch', info.branch ?? (info.repository ? 'Detached or branch not reported' : 'Not a repository root'))];
  for (const w of info.worktrees) {
    const allowed = projects.find(p => p.path === w.path);
    entries.push(entry(allowed ? allowed.name : 'Worktree outside this project authorization', [w.branch ?? (w.detached ? 'detached' : 'branch not reported'), w.locked ? 'locked' : 'not locked', allowed ? 'separate worktree directory; Git objects may be shared' : 'path redacted; not browsable'].join('; ')));
  }
  return view('Project and worktree', 'Separate worktrees isolate working files, not shared Git objects or external services. No isolation is inferred for two sessions in the same directory.', entries, [control('Refresh actual host state', { kind: 'project' })]);
}
