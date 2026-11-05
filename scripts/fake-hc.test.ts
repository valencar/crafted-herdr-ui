// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts", "fake-hc");
const dirs: string[] = [];

function fixtureDir(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-hc-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(
      join(dir, name),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Run {
  stdout: string;
  stderr: string;
  status: number | null;
  /** Whether the process was still running just before stdin was closed (only with closeAfterMs). */
  aliveAtClose: boolean;
}

/** Spawns `fake-hc connect`, writes `requests` (one line each), closes stdin, collects output. */
function connect(
  dir: string,
  requests: object[],
  opts: { args?: string[]; closeAfterMs?: number } = {},
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(script, opts.args ?? ["connect"], {
      env: { ...process.env, FAKE_HC_DIR: dir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    let aliveAtClose = false;
    let timer: NodeJS.Timeout | undefined;
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status, aliveAtClose });
    });
    child.stdin.on("error", () => {}); // the child may exit (drop) before we finish writing
    for (const r of requests) child.stdin.write(JSON.stringify(r) + "\n");
    if (opts.closeAfterMs === undefined) child.stdin.end();
    else {
      timer = setTimeout(() => {
        aliveAtClose = child.exitCode === null && child.signalCode === null;
        child.stdin.end();
      }, opts.closeAfterMs);
    }
  });
}

function lines(out: string): unknown[] {
  return out
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

function req(id: number, method: string, params: object = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

function sh(dir: string, ...args: string[]) {
  return spawnSync(script, args, {
    encoding: "utf8",
    env: { ...process.env, FAKE_HC_DIR: dir },
  });
}

describe("fake-hc", () => {
  it("prints_version_fixture", () => {
    expect(sh(fixtureDir(), "--version").stdout).toBe("hc 0.1.17\n");
    const dir = fixtureDir({ "version.txt": "hc 0.1.18\n" });
    const r = sh(dir, "--version");
    expect(r.stdout).toBe("hc 0.1.18\n");
    expect(r.status).toBe(0);
  });

  it("answers_hello_and_wraps_results_with_the_request_id", async () => {
    const dir = fixtureDir({
      "hello.json": { generation: 1 },
      "server.status.json": { running: true },
    });
    const r = await connect(dir, [req(7, "hello"), req(9, "server.status")]);
    expect(lines(r.stdout)).toEqual([
      { jsonrpc: "2.0", id: 7, result: { generation: 1 } },
      { jsonrpc: "2.0", id: 9, result: { running: true } },
    ]);
  });

  it("answers_by_global_call_number_across_processes", async () => {
    const dir = fixtureDir({
      "terminals.list@1.json": { n: 1 },
      "terminals.list@2.json": { n: 2 },
      "terminals.list.json": { n: "default" },
    });
    const a = await connect(dir, [req(1, "terminals.list")]);
    const b = await connect(dir, [
      req(1, "terminals.list"),
      req(2, "terminals.list"),
    ]);
    expect(lines(a.stdout)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { n: 1 } },
    ]);
    expect(lines(b.stdout)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { n: 2 } },
      { jsonrpc: "2.0", id: 2, result: { n: "default" } },
    ]);
    expect(
      JSON.parse(readFileSync(join(dir, ".counts.json"), "utf8"))[
        "terminals.list"
      ],
    ).toBe(3);
  });

  it("does_not_lose_counts_across_concurrent_processes", async () => {
    const n = 8;
    const files: Record<string, unknown> = {
      "terminals.list.json": { n: "default" },
    };
    for (let i = 1; i <= n; i++) files[`terminals.list@${i}.json`] = { n: i };
    const dir = fixtureDir(files);
    const runs = await Promise.all(
      Array.from({ length: n }, () => connect(dir, [req(1, "terminals.list")])),
    );
    const seen = runs.map(
      (r) => (lines(r.stdout)[0] as { result: { n: number } }).result.n,
    );
    expect([...seen].sort((a, b) => a - b)).toEqual(
      Array.from({ length: n }, (_, i) => i + 1),
    );
  });

  it("sends_fixture_errors_as_jsonrpc_errors", async () => {
    const error = {
      code: -32000,
      message: "t3 is blocked (question)",
      data: { kind: "blocked", hint: "read its screen first" },
    };
    const dir = fixtureDir({ "terminal.send.json": { error } });
    const r = await connect(dir, [req(4, "terminal.send"), req(5, "nope")]);
    expect(lines(r.stdout)).toEqual([
      { jsonrpc: "2.0", id: 4, error },
      {
        jsonrpc: "2.0",
        id: 5,
        error: {
          code: -32601,
          message: "no fixture",
          data: { kind: "not_found" },
        },
      },
    ]);
  });

  it("sleeps_before_replying_when_the_fixture_has_sleep_ms", async () => {
    const dir = fixtureDir({
      "slow.json": { sleep_ms: 300, result: { ok: true } },
      "slowerr.json": { sleep_ms: 50, error: { code: -1, message: "late" } },
    });
    const t0 = Date.now();
    const r = await connect(dir, [req(1, "slow"), req(2, "slowerr")]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(lines(r.stdout)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      { jsonrpc: "2.0", id: 2, error: { code: -1, message: "late" } },
    ]);
  });

  it("is_serial_within_one_process", async () => {
    const dir = fixtureDir({
      "slow.json": { sleep_ms: 200, result: { v: "slow" } },
      "fast.json": { v: "fast" },
    });
    const r = await connect(dir, [req(1, "slow"), req(2, "fast")]);
    expect(lines(r.stdout).map((l) => (l as { id: number }).id)).toEqual([
      1, 2,
    ]);
  });

  it("plays_nth_events_file_per_subscribe_then_drops", async () => {
    const ev = (seq: number) => ({
      jsonrpc: "2.0",
      method: "event",
      params: { seq, type: "created" },
    });
    const dir = fixtureDir({
      "events.subscribe.json": { seq: 5, terminals: [] },
      "events@1.jsonl":
        [JSON.stringify(ev(6)), '{"sleep_ms":50}', JSON.stringify(ev(7))].join(
          "\n",
        ) + "\n",
      "events@2.jsonl":
        [JSON.stringify(ev(8)), '{"drop":true}', JSON.stringify(ev(9))].join(
          "\n",
        ) + "\n",
      "events.jsonl": JSON.stringify(ev(99)) + "\n",
    });
    const first = await connect(dir, [req(1, "events.subscribe")], {
      closeAfterMs: 500,
    });
    expect(first.aliveAtClose).toBe(true); // the events ended with no drop, so it kept running
    expect(lines(first.stdout)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { seq: 5, terminals: [] } },
      ev(6),
      ev(7),
    ]);
    // The second subscribe plays events@2 and exits 0 at the drop line, stdin still open.
    const second = await connect(dir, [req(1, "events.subscribe")], {
      closeAfterMs: 5000,
    });
    expect(second.status).toBe(0);
    expect(lines(second.stdout)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { seq: 5, terminals: [] } },
      ev(8),
    ]);
    // The third falls back to events.jsonl.
    const third = await connect(dir, [req(1, "events.subscribe")], {
      closeAfterMs: 200,
    });
    expect(lines(third.stdout).slice(1)).toEqual([ev(99)]);
  });

  it("stays_alive_after_events_end_and_ignores_later_requests", async () => {
    const dir = fixtureDir({
      "events.subscribe.json": { seq: 1, terminals: [] },
      "events.jsonl": "",
      "hello.json": { generation: 1 },
    });
    const r = await connect(
      dir,
      [req(1, "events.subscribe"), req(2, "hello")],
      {
        closeAfterMs: 300,
      },
    );
    expect(r.aliveAtClose).toBe(true);
    expect(lines(r.stdout)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { seq: 1, terminals: [] } },
    ]);
    expect(r.status).toBe(0);
  });

  it("attach_prints_screen_last_line_and_exit_code", () => {
    const dir = fixtureDir({
      "attach_screen.txt": "screen text\n",
      "attach_last_line.txt": "[detached from t7]", // no trailing newline: fake-hc adds exactly one
      "attach_exit.txt": "3\n",
    });
    const r = sh(dir, "attach", "--observe", "t7");
    expect(r.stdout).toBe("screen text\n");
    expect(r.stderr).toBe("[detached from t7]\n");
    expect(r.status).toBe(3);
    const bare = sh(fixtureDir(), "attach", "t7");
    expect(bare.status).toBe(0);
    expect(bare.stdout).toBe("");
  });

  it("exit_fixture_logs_the_request_then_exits_0_without_replying", async () => {
    const dir = fixtureDir({
      "terminals.list@2.json": { exit: true },
      "terminals.list.json": { ok: true },
    });
    const first = await connect(dir, [req(1, "terminals.list")]);
    expect(lines(first.stdout)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
    ]);
    const request = req(2, "terminals.list");
    const second = await connect(dir, [request, req(3, "terminals.list")], {
      closeAfterMs: 5000,
    });
    expect(second.status).toBe(0);
    expect(second.stdout).toBe("");
    expect(second.aliveAtClose).toBe(false);
    const log = readFileSync(join(dir, "calls.log"), "utf8");
    expect(log).toContain(JSON.stringify(request));
    expect(log).not.toContain(JSON.stringify(req(3, "terminals.list")));
  });

  it("machine_subcommands_print_ok_and_other_argv_exits_2", () => {
    const dir = fixtureDir();
    for (const sub of ["login", "update", "add"]) {
      const r = sh(dir, "machine", sub, "buildbox");
      expect(r.stdout).toBe("ok\n");
      expect(r.status).toBe(0);
    }
    expect(sh(dir, "frobnicate").status).toBe(2);
    expect(sh(dir, "machine", "remove", "x").status).toBe(2);
  });

  it("logs_every_request", async () => {
    const dir = fixtureDir({ "terminal.read.json": { text: "" } });
    const request = req(1, "terminal.read", { address: "t1", lines: 0 });
    await connect(dir, [request], { args: ["connect", "--session", "dev"] });
    sh(dir, "--version");
    const log = readFileSync(join(dir, "calls.log"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(log).toEqual([
      'argv ["connect","--session","dev"]',
      JSON.stringify(request),
      'argv ["--version"]',
    ]);
    expect(log[1]).toContain('"lines":0');
  });
});
