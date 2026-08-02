# Chief organizations, execution, and surfaces

## Decision

Chief is a durable, organization-scoped service. It is not the repository that
contains it, a permanently running terminal, or a single omniscient agent.

The Chief repository remains the reference implementation, local cockpit, and
versioned operating contract. Agent Relay Cloud owns durable identity, inboxes,
schedules, runs, approvals, and placement. Enrolled machines and Cloud runtimes
are interchangeable execution capacity selected by policy and capability.

Khaliq starts with three isolated organizations:

| Organization | Organization Chief | Repositories | Trust boundary |
|---|---|---|---|
| AgentWorkforce | `chief-agentworkforce-khaliq` | AgentWorkforce repositories | Company |
| PRPM | `chief-prpm-khaliq` | repositories in the `pr-pm` GitHub organization | Company |
| Personal | `chief-personal-khaliq` | `life-agent`, `tax-agent`, `finances-agent` | Restricted personal |

Will retains `chief-will` during migration. Renaming an address is not a
prerequisite for moving to the organization model.

## One front door, scoped Chiefs

Khaliq can address one front door as `chief-khaliq`. That front door contains
only the organization directory, surface identity mappings, and the minimum
context needed to route a message. It delegates to an organization Chief and
does not union company, tax, finance, and life memory into one prompt.

An explicit organization in a conversation always wins. A surface or channel
can provide a default organization. Ambiguous high-impact requests require the
principal to choose a destination. Responses return to the originating thread
unless the principal explicitly asks for another surface.

This gives the convenience of one Chief without turning a compromised Slack
message, GitHub issue, or company integration into access to personal records.

## Personal Chief

Create a dedicated `personal-khaliq` Cloud workspace with separate RelayAuth
grants, Relayfile namespace, integrations, memory, audit log, and execution
policy. Register these repositories by stable repository ID and remote URL:

- `git@github.com:khaliqgant/life-agent.git`
- `git@github.com:khaliqgant/tax-agent.git`
- `git@github.com:khaliqgant/finances-agent.git`

Local paths are node-specific clone mappings, not Cloud identity:

```text
khaliq-personal-mac
  khaliqgant/life-agent     -> /Users/khaliqgant/Sites/life-agent
  khaliqgant/tax-agent      -> /Users/khaliqgant/Sites/tax-agent
  khaliqgant/finances-agent -> /Users/khaliqgant/Sites/finances-agent
```

The first personal execution pool should be an enrolled logical node tagged
`org:personal-khaliq`, `trust:restricted`, and `location:khaliq-mac`. Cloud can
hold encrypted control-plane state and messages, but raw journal exports, tax
documents, bank statements, `.env` files, and other source material stay on
that trusted node until a reviewed encrypted-storage policy exists. Personal
repositories are never mounted into an AgentWorkforce or PRPM Chief.

The personal Chief is durably addressable even when the Mac is offline. Work
queues in Cloud and wakes when an eligible personal node becomes available.

## Canonical model

```text
Account
└── Organization
    ├── Workspace (Relaycast + Relayfile + RelayAuth identity)
    ├── Principals
    │   └── Chief deployment
    │       ├── durable inbox and conversations
    │       ├── memory and work-item ledger
    │       ├── schedules, triggers, and approvals
    │       └── agent teams
    ├── Repositories and integrations
    └── Execution pools
        ├── Cloud runtimes
        └── enrolled nodes, including Mac minis
```

An organization has one durable WorkItem ledger. Linear issues, GitHub issues,
Notion pages, Slack threads, Telegram conversations, and Chief-created internal
tasks are projections or sources; none is required to be the canonical issue
database. Each repository's `factory.config.json` declares how dispatch and
verification work for that repository.

Repository availability is dynamic. Cloud stores an organization repository
registry and policy; nodes advertise clone mappings and capabilities. There is
no fixed source-code allowlist and no machine name embedded in a deployment.
Placement uses requirements such as organization, trust level, platform,
repository, and capability. Operators can change the eligible pool or local
clone mapping without redefining the agent.

## Surfaces

Every adapter produces the same authenticated ingress envelope:

```json
{
  "organizationId": "personal-khaliq",
  "principalId": "khaliq",
  "provider": "telegram",
  "externalConversationId": "...",
  "externalMessageId": "...",
  "actorId": "...",
  "text": "...",
  "attachments": [],
  "replyTo": null
}
```

The gateway maps the external actor to a RelayAuth principal, resolves the
organization, deduplicates the external message ID, checks channel and action
policy, then sends a canonical conversation event to Chief's durable inbox.

- Telegram and Slack are direct conversational transports. Authorized DMs and
  configured channel mentions wake Chief and responses return to that thread.
- Linear and GitHub are both conversational and work-object transports. An
  assignment, mention, comment, or state change can wake Chief and update the
  linked WorkItem.
- Notion is primarily a knowledge and work-object surface. Page mentions and
  database changes are events; explicit comments can be conversations.
- Relay is the native transport between Chiefs and agents.

Provider-specific code stays in adapters. Chief receives one event type and
uses the same authorization, memory, approval, and audit path on every surface.
Slack and Telegram can drive Chief directly, but they do not bypass gates for
merges, releases, money movement, external messages, or sensitive data access.

## Local and Cloud control

The local cockpit and Cloud panel are two clients of the same control-plane
API. Neither owns a second copy of Chief state.

The Cloud route should be organization and deployment scoped:

```text
/dashboard/organizations/:organizationId/chiefs/:chiefId
```

The panel composes existing deployment, run, schedule, work-item, and fleet
APIs and adds Chief-specific views:

- Chat and inbox, with the current surface and organization visible
- WorkItems, plans, delegated agents, and Factory runs
- Approvals and human gates
- Memory sources, retention, and deletion controls
- Senses, connections, scopes, and surface routing
- Eligible execution pools, current placement, health, and logs
- Audit history for every external event and material action

The local `npm run orgchart` cockpit shows the active organization, local
agents, Cloud, and enrolled nodes. Local View/Drive is available only for an
agent attached to that broker; Cloud control uses authenticated deployment and
run APIs. Start, stop, wake, re-place, approve, and revoke are explicit audited
commands rather than edits to a local JSON file.

## Customer shape

A customer signs up, creates or joins an organization, connects one preferred
conversation surface and one work surface, registers repositories or business
systems, and deploys an organization Chief. Chief starts with observation and
coordination permissions, proposes a team, and earns additional autonomy
through explicit gates.

Customers do not manage a collection of terminals. They see a Chief, its team,
the work being pursued, why it acted, what is waiting for approval, and where
the work is executing. Technical customers can inspect and customize the
versioned agent and Factory contracts; non-technical customers use the same
Cloud model through guided onboarding.

## Migration sequence

1. Merge the current Chief stack with a one-release v1 compatibility reader.
   Existing `teams.json` and `chief.config.json` continue to work unchanged.
2. Will can pull and restart without migrating. `npm run config:migrate` is a
   read-only preview; `npm run config:migrate -- --write` makes a rollback copy
   and converts only his ignored active `teams.json`.
3. Add organization, repository-registry, execution-pool, and surface records
   to Cloud. Preserve existing agent addresses as aliases.
4. Move the local cockpit onto those APIs and add the dedicated Cloud Chief
   panel.
5. Deploy AgentWorkforce and PRPM Chiefs, then the restricted Personal Chief.
6. Add Telegram and Slack direct adapters first; add Linear, GitHub, and Notion
   through the same ingress and WorkItem contract.
7. Remove the v1 reader only after both founders' deployments report v2 and a
   rollback window has elapsed.
