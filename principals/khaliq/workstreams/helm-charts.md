---
status: active
owner: unassigned
previous_owner: relayfile-helm-lead-0811
reports_to: chief
updated: 2026-08-11
repos: [helm-charts]
---

Goal: one repo holding every service's Helm chart, organized by folder, not a
new repo per chart.

## Cleanup checkpoint — 2026-08-11 15:48 CEST

`relayfile-helm-lead-0811` completed its recovery work and was released after
44 minutes waiting with no pending messages.

- The two post-merge failures were separated: the first run could not resolve
  the missing `origin/gh-pages`; the retry then hit an existing
  `relayfile-0.1.0` release.
- The lead bootstrapped an orphan `gh-pages` branch with an empty `index.yaml`
  and opened **helm-charts#3**, adding `skip_existing: true`. GitHub currently
  shows the PR open with CodeRabbit and cubic green.
- A real kind/Kubernetes install created the ServiceAccount, Secret, Service,
  and Deployment and uninstalled cleanly. This proves the chart installs into
  a cluster. It does not yet prove the actual relayfile image starts, passes its
  health probe, and serves traffic; the test used an nginx stand-in whose pod
  failure was expected under `readOnlyRootFilesystem`.

The lane is therefore waiting on Khaliq to merge #3, then on a post-merge
release/index check and an actual relayfile workload smoke test before anyone
calls it fully end-to-end.

## Now — 2026-08-11 — Khaliq ruled the repo structure while relayfile's chart was mid-build

**Khaliq: "I think we'll want a single repo for all of our helm charts and just
folder per service to keep it more organized. I'm going to rename that repo to
just be helm-charts."** `AgentWorkforce/relayfile-helm-charts` (created earlier
tonight, structured like `NangoHQ/nango-helm-charts`) becomes
`AgentWorkforce/helm-charts` — the first entry in a multi-service repo, not a
single-purpose one.

**Rename is Khaliq's own action**, not dispatched to an agent. `relayfile-helm-lead-0811`
was mid-PR (`#2`, `feat/initial-helm-chart`) when this landed and was
redirected to: confirm nothing in the repo assumes single-chart-per-repo
(`Chart.yaml` naming, README title, CI workflow paths, the chart-releaser
config in `.github/workflows/release.yml` scoping to the whole repo rather
than `charts/relayfile/`), and update its git remote once the rename lands.

**Structural implication for every future chart:** land as a new
`charts/<service>/` folder in this one repo, never a new repo. Whoever charts
the next service starts here.

## Next

1. Khaliq reviews and merges **helm-charts#3**.
2. Verify the post-merge Release Charts workflow updates `gh-pages`, then prove
   `helm repo add` and `helm install` work from the published repository.
3. Run the actual relayfile image in the cluster and prove startup, health, and
   traffic; the kind object-creation proof alone is not full end-to-end proof.
4. Add every future service as `charts/<service>/` in this repository.

## History

- **2026-08-11** — **Correction: not actually done.** Khaliq asked directly
  whether this was fully vetted end-to-end — it was not, and the earlier
  "done" status was premature. What was actually verified before merge was
  `helm lint --strict` (0 errors) and `helm template` (valid YAML) — both
  static/dry-run checks, not a real deployment. The post-merge "Release
  Charts" CI run (chart-releaser-action, which publishes the chart so `helm
  repo add` works) **failed** (run 31478666858, 09:40Z) and has not been
  re-run or fixed since; the `gh-pages` branch it would publish to does not
  exist. Reopened as active. Reassigning to `relayfile-helm-lead-0811` (or a
  fresh instance if it doesn't respond) to fix the release CI failure and
  prove an actual `helm install` against a real cluster, not just lint/template.
- **2026-08-11** — Repo rename confirmed (`AgentWorkforce/helm-charts`
  resolves; `relayfile-helm-charts` now redirects to it), and `#2` (`feat:
  initial Helm chart for relayfile server`) merged 09:39:12Z.
- **2026-08-11** — Workstream opened on Khaliq's structural ruling, made while
  `relayfile-helm-charts#2` was open under the old one-repo-per-chart model.
