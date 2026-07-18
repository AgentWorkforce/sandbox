import assert from "node:assert/strict";
import { test } from "node:test";

import { PACKAGE_NAME } from "./index.js";

test("package entry point is importable", () => {
  assert.equal(PACKAGE_NAME, "@agent-relay/sandbox");
});
