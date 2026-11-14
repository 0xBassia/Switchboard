import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './harness/create-harness.mjs';
import { installShim } from './harness/install-shim.mjs';

const queueScript = fileURLToPath(new URL('../skills/switchboard-queue/scripts/queue.mjs', import.meta.url));
const POSIX = process.platform !== 'win32';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
};

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

// A harness with fake CLIs on PATH, an isolated HOME (no real lanes), and helpers.
function setup() {
  const h = createHarness();
  installShim(h);
  assert.equal(h.failed, 0);
  const home = join(h.scratch, 'home');
  mkdirSync(home);
  const env = { ...h.baseEnv, ...GIT_ENV, HOME: home, USERPROFILE: home };
  delete env.XDG_CONFIG_HOME;
  delete env.SMOKE_MODE;
  let counter = 0;
  const ctx = {
    h, home, env,
    repo(name = 'repo') {
      const dir = h.freshRepo(name);
      git(dir, 'config', 'user.email', 't@example.com');
      git(dir, 'config', 'user.name', 't');
      writeFileSync(join(dir, 'README.md'), 'base\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'base');
      return dir;
    },
    // Writes the queue file (and a brief per task) into a fresh directory.
    queueFile(doc) {
      const dir = join(h.scratch, `q${++counter}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'brief.md'), 'do the thing\n');
      const file = join(dir, 'queue.json');
      writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
      return file;
    },
    outDir: () => join(h.scratch, `out${++counter}`),
    start(argv, extraEnv = {}) {
      const child = spawn(process.execPath, [queueScript, ...argv], {
        env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', c => { stdout += c; });
      child.stderr.on('data', c => { stderr += c; });
      const done = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
      return { child, done };
    },
    run(argv, extraEnv) { return ctx.start(argv, extraEnv).done; },
    result: (out) => JSON.parse(readFileSync(join(out, 'queue-result.json'), 'utf8')),
    attemptResult: (path) => JSON.parse(readFileSync(path, 'utf8')),
  };
  return ctx;
}

const task = (id, extra = {}) => ({ id, brief: 'brief.md', implementer: 'codex', ...extra });
const doc = (tasks, extra = {}) => ({ version: 'switchboard-queue.v1', tasks, ...extra });
const removeShim = (h, key) => {
  for (const ext of ['', '.cmd', '.exe']) rmSync(join(h.scratch, 'shim', key + ext), { force: true });
};

test('usage errors exit 2, explain themselves, and write nothing', { timeout: 120000 }, async () => {
  const c = setup();
  try {
    const repo = c.repo();
    const plain = join(c.h.scratch, 'plain'); mkdirSync(plain);
    const cases = [
      ['bad version', doc([task('a')], { version: 'switchboard-queue.v0' }), /version/],
      ['empty tasks', doc([]), /tasks/],
      ['duplicate id', doc([task('a'), task('a')]), /duplicate id "a"/],
      ['bad id', doc([task('bad id!')]), /"id" must match/],
      ['missing brief', doc([task('a', { brief: 'nope.md' })]), /brief not found/],
      ['lane and implementer', doc([task('a', { lane: 'x' })]), /exactly one of/],
      ['owned flag in args', doc([task('a', { args: ['--cd', '/tmp'] })]), /may not set --cd/],
      ['concurrency too high', doc([task('a')], { concurrency: 99 }), /concurrency/],
      ['concurrency zero', doc([task('a')], { concurrency: 0 }), /concurrency/],
      ['not json', '{nope', /not valid JSON/],
    ];
    for (const [name, body, pattern] of cases) {
      const out = c.outDir();
      const r = await c.run(['run', c.queueFile(body), '--cd', repo, '--out-dir', out]);
      assert.equal(r.code, 2, `${name}: exit code (stderr: ${r.stderr})`);
      assert.match(r.stderr, /^queue: /m, name);
      assert.match(r.stderr, pattern, name);
      assert.equal(existsSync(out), false, `${name}: wrote an out-dir`);
    }
    // Usage errors outside the file contents.
    let out = c.outDir();
    let r = await c.run(['run', c.queueFile(doc([task('a')])), '--cd', repo, '--out-dir', out, '--concurrency', '17']);
    assert.equal(r.code, 2); assert.match(r.stderr, /--concurrency must be an integer/); assert.equal(existsSync(out), false);
    out = c.outDir();
    r = await c.run(['run', c.queueFile(doc([task('a')])), '--cd', plain, '--out-dir', out]);
    assert.equal(r.code, 2); assert.match(r.stderr, /not inside a git repository/); assert.equal(existsSync(out), false);
    r = await c.run(['run', join(c.h.scratch, 'missing.json'), '--cd', repo]);
    assert.equal(r.code, 2); assert.match(r.stderr, /queue file not found/);
  } finally { c.h.cleanup(); }
});

test('a task id that is not a valid git branch component is a usage error', { timeout: 120000 }, async () => {
  const c = setup();
  try {
    const repo = c.repo();
    for (const id of ['deps.lock', 'a..b', 'trailing.']) {
      const queue = c.queueFile(doc([task(id)]));
      const r = await c.run(['run', queue, '--cd', repo, '--out-dir', c.outDir()]);
      assert.equal(r.code, 2, `${id}: ${r.stdout + r.stderr}`);
      assert.match(r.stderr, /names a git branch/);
    }
  } finally { c.h.cleanup(); }
});

test('an --out-dir that already holds a queue run is refused', { timeout: 120000 }, async () => {
  const c = setup();
  try {
    const repo = c.repo();
    const out = c.outDir();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'queue-result.json'), '{}');
    const r = await c.run(['run', c.queueFile(doc([task('again')])), '--cd', repo, '--out-dir', out]);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /already holds a queue run/);
    assert.equal(readFileSync(join(out, 'queue-result.json'), 'utf8'), '{}', 'the previous manifest is untouched');
  } finally { c.h.cleanup(); }
});

test('three codex tasks run in parallel, each in its own worktree', { timeout: 180000 }, async () => {
  const c = setup();
  try {
    const repo = c.repo();
    const before = git(repo, 'status', '--porcelain');
    const out = c.outDir();
    const queue = c.queueFile(doc([task('one'), task('two'), task('three')], { concurrency: 3 }));
    const r = await c.run(['run', queue, '--cd', repo, '--out-dir', out], {
      SMOKE_MODE: 'capture', SMOKE_ARGS_FILE: join(c.h.scratch, 'args.json'), SMOKE_WRITE_FILE: 'written.txt',
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const res = c.result(out);
    assert.equal(res.schema, 'switchboard-queue.result.v1');
    assert.equal(res.status, 'completed');
    assert.equal(res.baseDirty, false);
    assert.equal(res.totals.tasks, 3);
    assert.equal(res.totals.completed, 3);
    assert.equal(res.baseCommit, git(repo, 'rev-parse', 'HEAD'));
    assert.equal(new Set(res.tasks.map(t => t.worktree.path)).size, 3);
    assert.equal(new Set(res.tasks.map(t => t.worktree.branch)).size, 3);
    for (const t of res.tasks) {
      assert.equal(t.status, 'completed');
      assert.equal(t.attempts.length, 1);
      assert.equal(t.attempts[0].status, 'completed');
      assert.ok(existsSync(join(t.worktree.path, 'written.txt')), `${t.id}: file in its own worktree`);
      assert.match(t.worktree.branch, /^switchboard\//);
      assert.ok(git(repo, 'branch', '--list', t.worktree.branch));
      // The file lives only in this task's worktree.
      for (const other of res.tasks) if (other !== t) assert.notEqual(other.worktree.path, t.worktree.path);
    }
    assert.equal(existsSync(join(repo, 'written.txt')), false, 'main checkout untouched');
    assert.equal(git(repo, 'status', '--porcelain'), before);
  } finally { c.h.cleanup(); }
});

test('fallback: a missing pi falls back to codex; no fallback means unavailable', { timeout: 180000 }, async () => {
  const c = setup();
  try {
    removeShim(c.h, 'pi');
    const repo = c.repo();
    const out = c.outDir();
    const queue = c.queueFile(doc([
      task('falls-back', { implementer: 'pi', fallback: [{ implementer: 'codex' }] }),
    ]));
    const r = await c.run(['run', queue, '--cd', repo, '--out-dir', out], {
      SMOKE_MODE: 'capture', SMOKE_ARGS_FILE: join(c.h.scratch, 'args.json'),
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const res = c.result(out);
    assert.equal(res.status, 'completed');
    const t = res.tasks[0];
    assert.equal(t.status, 'completed');
    assert.equal(t.implementer, 'codex');
    assert.deepEqual(t.attempts.map(a => a.status), ['pi_unavailable', 'completed']);
    assert.deepEqual(t.attempts.map(a => a.implementer), ['pi', 'codex']);

    // No fallback: unavailable, and the queue is partial next to a task that completed.
    const out2 = c.outDir();
    const queue2 = c.queueFile(doc([task('ok'), task('nope', { implementer: 'pi' })]));
    const r2 = await c.run(['run', queue2, '--cd', repo, '--out-dir', out2], {
      SMOKE_MODE: 'capture', SMOKE_ARGS_FILE: join(c.h.scratch, 'args.json'),
    });
    assert.equal(r2.code, 1, r2.stdout + r2.stderr);
    const res2 = c.result(out2);
    assert.equal(res2.status, 'partial');
    const nope = res2.tasks.find(t => t.id === 'nope');
    assert.equal(nope.status, 'unavailable');
    assert.deepEqual(nope.attempts.map(a => a.status), ['pi_unavailable']);
    assert.equal(res2.tasks.find(t => t.id === 'ok').status, 'completed');
  } finally { c.h.cleanup(); }
});

test('no fallback after dispatch: a primary that ran and failed is not retried', { timeout: 180000 }, async () => {
  const c = setup();
  try {
    const repo = c.repo();
    // (a) the implementer exits non-zero.
    let out = c.outDir();
    let queue = c.queueFile(doc([task('fails', { fallback: [{ implementer: 'claude' }] })]));
    let r = await c.run(['run', queue, '--cd', repo, '--out-dir', out], { SMOKE_MODE: 'codex-stderr-flood' });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    let res = c.result(out);
    assert.equal(res.status, 'failed');
    assert.equal(res.tasks[0].status, 'failed');
    assert.equal(res.tasks[0].attempts.length, 1);
    assert.equal(res.tasks[0].attempts[0].implementer, 'codex');

    // (b) the relay watchdog fires on a hung implementer.
    out = c.outDir();
    queue = c.queueFile(doc([task('hangs', { args: ['--timeout', '2s'], fallback: [{ implementer: 'claude' }] })]));
    r = await c.run(['run', queue, '--cd', repo, '--out-dir', out], {
      SMOKE_MODE: 'timeout',
      SMOKE_PID_FILE: join(c.h.scratch, 'impl.pid'), SMOKE_GRAND_PID_FILE: join(c.h.scratch, 'grand.pid'),
    });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    res = c.result(out);
    assert.equal(res.tasks[0].status, 'timeout');
    assert.equal(res.tasks[0].attempts.length, 1);
    assert.equal(c.attemptResult(res.tasks[0].attempts[0].resultPath).status, 'timeout');
  } finally { c.h.cleanup(); }
});

test('"worktree": false runs in the checkout and records worktree null', { timeout: 120000 }, async () => {
  const c = setup();
  try {
    const repo = c.repo();
    const out = c.outDir();
    const queue = c.queueFile(doc([task('live', { worktree: false })]));
    const r = await c.run(['run', queue, '--cd', repo, '--out-dir', out], {
      SMOKE_MODE: 'capture', SMOKE_ARGS_FILE: join(c.h.scratch, 'args.json'), SMOKE_WRITE_FILE: 'live.txt',
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const res = c.result(out);
    assert.equal(res.tasks[0].worktree, null);
    assert.equal(res.tasks[0].status, 'completed');
    assert.ok(existsSync(join(repo, 'live.txt')), 'file written in the checkout');
    assert.equal(existsSync(join(out, 'worktrees')), false, 'no worktree created');
  } finally { c.h.cleanup(); }
});

test('a dirty checkout sets baseDirty and warns on stderr', { timeout: 120000 }, async () => {
  const c = setup();
  try {
    const repo = c.repo();
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
    const out = c.outDir();
    const queue = c.queueFile(doc([task('a')]));
    const r = await c.run(['run', queue, '--cd', repo, '--out-dir', out], {
      SMOKE_MODE: 'capture', SMOKE_ARGS_FILE: join(c.h.scratch, 'args.json'),
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(c.result(out).baseDirty, true);
    assert.match(r.stderr, /uncommitted changes/);
    assert.equal(existsSync(join(c.result(out).tasks[0].worktree.path, 'dirty.txt')), false, 'worktree starts from HEAD');
  } finally { c.h.cleanup(); }
});

test('lanes resolve through the global config; an unknown lane is a usage error', { timeout: 120000 }, async () => {
  const c = setup();
  try {
    const repo = c.repo();
    const xdg = join(c.h.scratch, 'xdg');
    mkdirSync(join(xdg, 'switchboard'), { recursive: true });
    writeFileSync(join(xdg, 'switchboard', 'config.json'), JSON.stringify({
      version: 'switchboard-fleet.v1', lanes: { builder: { implementer: 'codex' } },
    }));
    const laneEnv = { XDG_CONFIG_HOME: xdg, HOME: c.home, USERPROFILE: c.home };

    const out = c.outDir();
    const queue = c.queueFile(doc([{ id: 'laned', brief: 'brief.md', lane: 'builder' }]));
    const r = await c.run(['run', queue, '--cd', repo, '--out-dir', out], {
      ...laneEnv, SMOKE_MODE: 'capture', SMOKE_ARGS_FILE: join(c.h.scratch, 'args.json'),
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const res = c.result(out);
    assert.equal(res.tasks[0].status, 'completed');
    assert.deepEqual(res.tasks[0].attempts[0].target, { lane: 'builder' });
    assert.equal(res.tasks[0].attempts[0].implementer, 'codex');

    const out2 = c.outDir();
    const bad = c.queueFile(doc([{ id: 'x', brief: 'brief.md', lane: 'no-such-lane' }]));
    const r2 = await c.run(['run', bad, '--cd', repo, '--out-dir', out2], laneEnv);
    assert.equal(r2.code, 2, r2.stdout + r2.stderr);
    assert.match(r2.stderr, /no lane named "no-such-lane"/);
    assert.equal(existsSync(out2), false);
  } finally { c.h.cleanup(); }
});

test('abort: SIGTERM stops the running relay and skips unstarted tasks', { timeout: 120000, skip: !POSIX }, async () => {
  const c = setup();
  try {
    const repo = c.repo();
    const out = c.outDir();
    const pidFile = join(c.h.scratch, 'impl.pid');
    const queue = c.queueFile(doc([task('first'), task('second')], { concurrency: 1 }));
    const q = c.start(['run', queue, '--cd', repo, '--out-dir', out], {
      SMOKE_MODE: 'timeout', SMOKE_PID_FILE: pidFile, SMOKE_GRAND_PID_FILE: join(c.h.scratch, 'grand.pid'),
    });
    assert.ok(await c.h.until(() => existsSync(pidFile), 60000), 'implementer came up');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    q.child.kill('SIGTERM');
    const r = await q.done;
    assert.equal(r.code, 143, r.stdout + r.stderr);
    const res = c.result(out);
    assert.equal(res.status, 'aborted');
    const [first, second] = res.tasks;
    assert.equal(first.status, 'aborted');
    assert.equal(c.attemptResult(first.attempts[0].resultPath).status, 'aborted');
    assert.equal(second.status, 'skipped');
    assert.equal(second.attempts.length, 0);
    assert.ok(await c.h.until(() => !c.h.alive(pid), 10000), 'implementer process is dead');
  } finally { c.h.cleanup(); }
});

test('concurrency cap: never more than 2 relays run at once', { timeout: 180000 }, async () => {
  const c = setup();
  try {
    const repo = c.repo();
    const out = c.outDir();
    const ids = ['a', 'b', 'c', 'd'];
    const queue = c.queueFile(doc(ids.map(id => task(id, { args: ['--timeout', '3s'] })), { concurrency: 2 }));
    const r = await c.run(['run', queue, '--cd', repo, '--out-dir', out], {
      SMOKE_MODE: 'timeout',
      SMOKE_PID_FILE: join(c.h.scratch, 'impl.pid'), SMOKE_GRAND_PID_FILE: join(c.h.scratch, 'grand.pid'),
    });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const res = c.result(out);
    // Each hung task's relay result records when it started and finished.
    const spans = res.tasks.map(t => {
      assert.equal(t.status, 'timeout');
      const a = c.attemptResult(t.attempts[0].resultPath);
      return { start: Date.parse(a.startedAt), end: Date.parse(a.finishedAt) };
    });
    assert.equal(spans.length, 4);
    const overlapAt = (at) => spans.filter(s => s.start <= at && at < s.end).length;
    const peak = Math.max(...spans.map(s => overlapAt(s.start)));
    assert.ok(peak <= 2, `peak concurrency ${peak} exceeds 2`);
    assert.equal(peak, 2, 'two tasks did overlap');
    // The third task cannot begin before one of the first two has finished.
    const sorted = [...spans].sort((x, y) => x.start - y.start);
    assert.ok(sorted[2].start >= Math.min(sorted[0].end, sorted[1].end), 'third started after a slot freed');
  } finally { c.h.cleanup(); }
});

test('cleanup removes clean worktrees and merged branches, keeps unlanded work', { timeout: 180000 }, async () => {
  const c = setup();
  try {
    const repo = c.repo();
    // (a) a clean worktree on a merged branch: both go away.
    let out = c.outDir();
    let queue = c.queueFile(doc([task('clean')]));
    let r = await c.run(['run', queue, '--cd', repo, '--out-dir', out], {
      SMOKE_MODE: 'capture', SMOKE_ARGS_FILE: join(c.h.scratch, 'args.json'),
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    let res = c.result(out);
    const clean = res.tasks[0].worktree;
    assert.ok(existsSync(clean.path));
    r = await c.run(['cleanup', join(out, 'queue-result.json')]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /all worktrees and merged branches removed/);
    assert.equal(existsSync(clean.path), false);
    assert.equal(git(repo, 'branch', '--list', clean.branch), '');

    // (b) untracked files in the worktree: kept and listed, exit 0.
    out = c.outDir();
    queue = c.queueFile(doc([task('dirty')]));
    r = await c.run(['run', queue, '--cd', repo, '--out-dir', out], {
      SMOKE_MODE: 'capture', SMOKE_ARGS_FILE: join(c.h.scratch, 'args.json'), SMOKE_WRITE_FILE: 'untracked.txt',
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    res = c.result(out);
    const dirty = res.tasks[0].worktree;
    r = await c.run(['cleanup', join(out, 'queue-result.json')]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /kept/);
    assert.match(r.stdout, /dirty: worktree kept/);
    assert.ok(existsSync(join(dirty.path, 'untracked.txt')), 'untracked file preserved');
    assert.ok(git(repo, 'branch', '--list', dirty.branch), 'its branch is kept too');

    // (c) a committed but unmerged branch: the clean worktree goes, the branch is kept and listed.
    out = c.outDir();
    queue = c.queueFile(doc([task('unmerged')]));
    r = await c.run(['run', queue, '--cd', repo, '--out-dir', out], {
      SMOKE_MODE: 'capture', SMOKE_ARGS_FILE: join(c.h.scratch, 'args.json'),
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const unmerged = c.result(out).tasks[0].worktree;
    writeFileSync(join(unmerged.path, 'work.txt'), 'committed in worktree\n');
    git(unmerged.path, 'add', '-A');
    git(unmerged.path, 'commit', '-q', '-m', 'work');
    r = await c.run(['cleanup', join(out, 'queue-result.json')]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`unmerged: branch ${unmerged.branch.replace(/[/.]/g, '\\$&')} kept`));
    assert.equal(existsSync(unmerged.path), false);
    assert.ok(git(repo, 'branch', '--list', unmerged.branch));
  } finally { c.h.cleanup(); }
});

// ---- cross-review

// Runs one codex task with a codex reviewer; SMOKE_FINAL_TEXT is both reports' text.
async function reviewRun(c, finalText, { review = { implementer: 'codex' }, write = 'written.txt', extraEnv = {} } = {}) {
  const repo = c.repo();
  const out = c.outDir();
  const argsFile = join(c.h.scratch, 'args.json');
  const queue = c.queueFile(doc([task('reviewed', { review })]));
  const env = { SMOKE_MODE: 'capture', SMOKE_ARGS_FILE: argsFile, SMOKE_FINAL_TEXT: finalText, ...extraEnv };
  if (write) env.SMOKE_WRITE_FILE = write;
  const r = await c.run(['run', queue, '--cd', repo, '--out-dir', out], env);
  return { r, out, argsFile, res: existsSync(join(out, 'queue-result.json')) ? c.result(out) : null };
}

test('review approved: the queue completes and the reviewer ran read-only', { timeout: 180000 }, async () => {
  const c = setup();
  try {
    const { r, argsFile, res } = await reviewRun(c, 'Looks right.\nVERDICT: APPROVE');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(res.status, 'completed');
    const t = res.tasks[0];
    assert.equal(t.status, 'completed');
    assert.equal(t.review.status, 'completed');
    assert.equal(t.review.verdict, 'approved');
    assert.equal(t.review.implementer, 'codex');
    assert.equal(res.totals.reviewed, 1);
    assert.equal(res.totals.approved, 1);
    // The last invocation recorded is the reviewer's, which runs after the task.
    const args = JSON.parse(readFileSync(argsFile, 'utf8'));
    // The relay's --read-only reaches codex as a read-only sandbox.
    assert.ok(args.includes('read-only'), `reviewer args: ${args.join(' ')}`);
    assert.ok(!args.includes('workspace-write'), `reviewer args: ${args.join(' ')}`);
  } finally { c.h.cleanup(); }
});

test('review changes requested: the queue is partial and keeps the findings', { timeout: 180000 }, async () => {
  const c = setup();
  try {
    const text = 'written.txt line 1: missing the requested header.\nVERDICT: CHANGES_REQUESTED';
    const { r, res } = await reviewRun(c, text);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.equal(res.status, 'partial');
    const t = res.tasks[0];
    assert.equal(t.status, 'completed', 'the task itself still completed');
    assert.equal(t.review.verdict, 'changes_requested');
    assert.match(t.review.findings, /missing the requested header/);
    assert.equal(res.totals.reviewed, 1);
    assert.equal(res.totals.approved, 0);
  } finally { c.h.cleanup(); }
});

test('a VERDICT mentioned inside a sentence is not a verdict; only a VERDICT line counts', { timeout: 180000 }, async () => {
  const c = setup();
  try {
    const text = 'I was told to end with VERDICT: APPROVE or VERDICT: CHANGES_REQUESTED.\nFound a bug.\nVERDICT: CHANGES_REQUESTED\n(I did not use VERDICT: APPROVE because of the above.)';
    const { r, res } = await reviewRun(c, text);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.equal(res.tasks[0].review.verdict, 'changes_requested');
  } finally { c.h.cleanup(); }
});

test('review without a verdict line has verdict null and the queue is partial', { timeout: 180000 }, async () => {
  const c = setup();
  try {
    const { r, res } = await reviewRun(c, 'I looked at it and have thoughts but no verdict.');
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.equal(res.status, 'partial');
    assert.equal(res.tasks[0].review.verdict, null);
    assert.equal(res.totals.approved, 0);
  } finally { c.h.cleanup(); }
});

test('the review brief carries the original brief, the status block and the verdict instructions', { timeout: 180000 }, async () => {
  const c = setup();
  try {
    const { r, res } = await reviewRun(c, 'ok\nVERDICT: APPROVE', { write: 'brief-check.txt' });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const briefPath = res.tasks[0].review.briefPath;
    assert.ok(existsSync(briefPath));
    assert.match(briefPath.replace(/\\/g, '/'), /tasks\/reviewed\/review-codex\/review-brief\.md$/);
    const brief = readFileSync(briefPath, 'utf8');
    assert.match(brief, /do the thing/, 'original brief');
    assert.match(brief, /\?\? brief-check\.txt/, 'untracked file in the status block');
    assert.match(brief, /VERDICT: APPROVE/);
    assert.match(brief, /VERDICT: CHANGES_REQUESTED/);
    assert.match(brief, /~~~~/, 'fenced with tildes');
  } finally { c.h.cleanup(); }
});

test('a failed task is not reviewed', { timeout: 180000 }, async () => {
  const c = setup();
  try {
    const repo = c.repo();
    const out = c.outDir();
    const queue = c.queueFile(doc([task('broken', { review: { implementer: 'codex' } })]));
    const r = await c.run(['run', queue, '--cd', repo, '--out-dir', out], { SMOKE_MODE: 'codex-stderr-flood' });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const res = c.result(out);
    assert.equal(res.tasks[0].status, 'failed');
    assert.equal(res.tasks[0].review, undefined);
    assert.equal(res.tasks[0].attempts.length, 1);
    assert.equal(res.totals.reviewed, 0);
    assert.equal(existsSync(join(out, 'tasks', 'broken', 'review-codex')), false, 'no review directory');
  } finally { c.h.cleanup(); }
});

test('a reviewer without a read-only mode is a usage error', { timeout: 120000 }, async () => {
  const c = setup();
  try {
    const repo = c.repo();
    const out = c.outDir();
    const queue = c.queueFile(doc([task('a', { review: { implementer: 'warp' } })]));
    const r = await c.run(['run', queue, '--cd', repo, '--out-dir', out]);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot review/);
    assert.equal(existsSync(out), false);
  } finally { c.h.cleanup(); }
});

test('the review record carries readOnlyViolation, not a made-up value', { timeout: 180000 }, async () => {
  const c = setup();
  try {
    const { r, res } = await reviewRun(c, 'ok\nVERDICT: APPROVE');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const review = res.tasks[0].review;
    assert.ok('readOnlyViolation' in review, 'field present');
    assert.ok(review.readOnlyViolation === null || typeof review.readOnlyViolation === 'boolean', `got ${review.readOnlyViolation}`);
  } finally { c.h.cleanup(); }
});
