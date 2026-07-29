---
status: active
owner: cloud
updated: 2026-07-29
repos: [cloud]
---
# cloud — AWS teardown

**Goal:** Cloudflare-only. `infra/README.md`: "The SST app's `home: "aws"`
reflects the current hybrid state, not a target." Tracking issue cloud#1967
(Phases A–E). Note: "Phase 3/4/5" is the separate May Workers-migration
numbering.

**Now:** substantially done. Gone: Aurora (DB is Neon, branch-per-stage),
the cloud-web Lambda + CloudFront router + entire VPC/NAT/bastion/ECS
(Phase 5, #1949, 07-13 — Lambda drained to 0 invocations first), admin app,
SNS OpsAlarms, Nango SQS+Lambda path. Cloudflare now dominates: 17 Workers,
12 KV, 9 CF Queues, 4 D1, 4 R2, 2 CF Crons.

**Next:** Phase B — S3 `SandboxStorage` → R2; Phase C — four SQS queues
(GithubClone, WorkflowLaunch + DLQs) → CF Queues. Phase D tail: `StsBroker` +
`QueueBridge` Lambdas. Then: three `sst.aws.Cron`, SES (prod), IAM/SSM;
three AWS accounts still gate deploys.

## History
- 2026-07-29 — Inventory verified by reading each infra/*.ts on fresh main.
  Stale-doc hazards to fix: infra/README.md:63-78 documents a VPC section
  linking a deleted file; docs/migration/phase5-decommission.md still opens
  "Status: plan-only. Do NOT execute" though its body records execution.
