# Relay flows API

Relay's comment and DM flows, for Apollo's Social seat and the publishing suite's "Relay" option on a post. The lead inbox API (`/api/relay/v1`) is separate.

Auth is the same workspace service key (`Authorization: Bearer orly_...`), minted with its own scopes:

    npm run relay:key -- --workspace <id> --name social --scopes flows:read,flows:write

| Call | Scope | What it does |
|---|---|---|
| `GET /api/flows/v1?limit=20` | `flows:read` | the workspace's flows, newest first, each with `results`: DMs sent, skipped and failed, public replies, link clicks and click rate |
| `GET /api/flows/v1/:id` | `flows:read` | one flow's results and its top keywords. Comment text is never returned |
| `POST /api/flows/v1` | `flows:write` plus a flow grant | creates a live flow on a published post |

## Creating a flow

A new flow answers comments and sends DMs on its own, so the API creates one only on a person's approval. Apollo signs a flow grant (`lib/leads/grant.ts`, audience `openreply.relay.flow`) with `RELAY_FLOW_GRANT_SECRET` (its own secret, at least 32 characters, not the send grant's) and sends it as `x-flow-grant`. The grant names the workspace and the SHA-256 of the exact request body. The approval id is stored on the flow under a unique index, so a repeat returns the same flow (`replay: true`) and never makes a second one.

Body (`FlowBody` in `lib/automation/flows-api.ts`):

| Field | |
|---|---|
| `name`, `goal` | how the flow is labelled in the dashboard |
| `postId` or `nextReel: true` | the published post's media id, or the account's next reel |
| `keywords` or `matchAnyWord: true` | the words in a comment that trigger the DM |
| `dmMessage` | the DM a matching commenter receives |
| `publicReplies` | public replies under the comment, one picked each time; empty for none |
| `linkUrl`, `linkButtonLabel` | an https link, tracked, as a DM button |
| `requireFollow` | ask the commenter to follow before the link |
| `platform` | `instagram`, the only platform connected today |

Errors are 4xx and final: `GRANT_MISSING`, `GRANT_BAD_SIGNATURE`, `GRANT_EXPIRED`, `GRANT_MALFORMED`, `GRANT_WRONG_WORKSPACE`, `GRANT_BODY_MISMATCH`, `MISSING_SCOPE`, `ACCOUNT_NOT_CONNECTED`, `INVALID_REQUEST`.
