import assert from "node:assert/strict";
import test from "node:test";
import {
  exactSensesMountPlan,
  mountPidsFromGeneration,
  mountProcessesHealthy,
} from "./senses-mount-plan.mjs";

test("plans one exact local and private-state root per remote subtree", () => {
  assert.deepEqual(exactSensesMountPlan({
    remotePaths: ["/linear", "/github/repos", "/notion"],
    localRoot: "/srv/chief/senses",
    stateRoot: "/srv/chief/runtime/state",
  }), [
    {
      remotePath: "/linear",
      localDir: "/srv/chief/senses/linear",
      stateDir: "/srv/chief/runtime/state/linear",
    },
    {
      remotePath: "/github/repos",
      localDir: "/srv/chief/senses/github/repos",
      stateDir: "/srv/chief/runtime/state/github/repos",
    },
    {
      remotePath: "/notion",
      localDir: "/srv/chief/senses/notion",
      stateDir: "/srv/chief/runtime/state/notion",
    },
  ]);
});

test("rejects roots, relative paths, traversal, and duplicate mounts", () => {
  const plan = (remotePaths) => exactSensesMountPlan({
    remotePaths,
    localRoot: "/srv/chief/senses",
    stateRoot: "/srv/chief/runtime/state",
  });
  assert.throws(() => plan([]), /at least one/u);
  assert.throws(() => plan(["/"]), /not an exact subtree/u);
  assert.throws(() => plan(["github"]), /must be absolute/u);
  assert.throws(() => plan(["/github/../linear"]), /not an exact subtree/u);
  assert.throws(() => plan(["/github", "/github"]), /duplicated/u);
});

test("serializes only live generation pids", () => {
  const generation = {
    ended: false,
    children: new Map([
      ["/linear", { pid: 101 }],
      ["/github", { pid: 202 }],
    ]),
  };
  assert.deepEqual(mountPidsFromGeneration(generation), {
    "/linear": 101,
    "/github": 202,
  });
  generation.ended = true;
  assert.deepEqual(mountPidsFromGeneration(generation), {});
});

test("requires every exact mount process while accepting legacy state", () => {
  const alive = new Set([101, 202]);
  const isAlive = (pid) => alive.has(pid);
  assert.equal(mountProcessesHealthy({
    status: "running",
    mountPids: { "/linear": 101, "/github": 202 },
  }, ["/linear", "/github"], isAlive), true);
  assert.equal(mountProcessesHealthy({
    status: "running",
    mountPids: { "/linear": 101 },
  }, ["/linear", "/github"], isAlive), false);
  assert.equal(mountProcessesHealthy({ status: "running", mountPid: 202 }, [], isAlive), true);
  assert.equal(mountProcessesHealthy({ status: "restarting", mountPid: 202 }, [], isAlive), false);
});
