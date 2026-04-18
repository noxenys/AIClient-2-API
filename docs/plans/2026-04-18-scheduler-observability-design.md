# Scheduler Observability Enhancement Design

Date: 2026-04-18
Status: Approved for planning
Scope: AIClient-2-API provider runtime visibility enhancement

## 1. Context

AIClient-2-API already has the core pieces needed for provider runtime state tracking:

- `src/providers/provider-pool-manager.js` maintains runtime fields such as `state`, `stateScore`, `cooldownUntil`, `lastStateReason`, `recentFailureType`, `usageCount`, `errorCount`, `activeRequests`, and `waitingRequests`.
- `src/utils/provider-state.js` already defines the state model and selection rules (`healthy`, `cooldown`, `risky`, `banned`, `disabled`).
- `src/ui-modules/provider-api.js` already exposes `/api/providers` and `/api/providers?summary=true` with basic provider summary data.
- `static/app/provider-manager.js` already renders provider summaries and runtime state badges.

The current gap is not missing scheduler logic. The gap is that the scheduler is still too opaque in the UI and API. The operator can see that a node is unhealthy or cooling down, but cannot quickly answer:

- Why was this node skipped?
- Is it still selectable?
- Was the last failure `429`, `401/403`, upstream, or network?
- When will a `429` node recover?
- Which provider groups are currently degraded and why?

## 2. Goal

Make provider scheduling behavior transparent without rewriting the scheduler.

This iteration will expose the existing runtime decision data clearly enough that an operator can diagnose pool health and routing behavior from the existing Web UI and provider APIs.

## 3. Non-Goals

This design explicitly does not include:

- Rewriting provider selection strategy
- Adding downstream tenant billing or API key resale logic
- Adding a separate provider route alias system
- Adding bulk import/export management APIs
- Implementing a persistent event history database
- Building charts or heavy analytics dashboards

## 4. Options Considered

### Option A: Extend existing provider APIs and pages

Expose richer scheduler/runtime metadata through `/api/providers` and `/api/providers?summary=true`, then surface it in the current dashboard/provider views.

Pros:

- Reuses existing runtime fields and UI structure
- Smallest implementation risk
- No new subsystem to maintain
- Fastest path to operator value

Cons:

- Data shape of existing provider endpoints grows
- UI must stay disciplined to avoid becoming noisy

### Option B: Build a dedicated scheduler module and standalone page

Create new routes such as `/api/scheduler/*` and a separate scheduler operations page.

Pros:

- Clear conceptual separation
- Easier future expansion

Cons:

- Larger surface area
- More duplication with existing provider summaries
- Higher integration cost right now

### Option C: Build a scheduler event log / audit stream first

Record state transitions and selection decisions over time, then render historical diagnostics.

Pros:

- Best long-term debuggability

Cons:

- Requires new storage and retention rules
- Too large for the current iteration

## Recommendation

Choose Option A.

AIClient-2-API already has the necessary runtime state model and partial summary API. The correct move is to productize that data, not rebuild the scheduler around a new abstraction.

## 5. Design Summary

This iteration extends the existing provider management API and current dashboard/provider pages with explicit scheduler visibility.

The implementation has three parts:

1. Normalize and expose runtime scheduler fields in API responses
2. Aggregate provider-group level degradation summaries
3. Render concise but actionable runtime detail in the existing UI

## 6. Backend Design

### 6.1 API strategy

Do not add a new scheduler API namespace in this iteration.

Instead, extend these existing endpoints:

- `GET /api/providers`
- `GET /api/providers?summary=true`
- `GET /api/providers/:providerType`

This keeps the UI changes local and avoids route sprawl.

### 6.2 Node-level runtime fields

Each sanitized provider returned by the provider API should consistently expose these fields when available:

- `state`
- `stateScore`
- `isSelectable`
- `recentFailureType`
- `cooldownUntil`
- `lastStateReason`
- `lastErrorMessage`
- `usageCount`
- `errorCount`
- `consecutiveFailures`
- `activeRequests`
- `waitingRequests`

Field rules:

- `state` remains the canonical runtime state
- `isSelectable` is derived from `state` using existing selection rules
- `stateScore` is exposed as-is for operator visibility only, not as a public scheduling contract
- `recentFailureType` should use the current normalized categories:
  - `rate_limit`
  - `auth`
  - `upstream`
  - `network`
  - `unknown`
- `cooldownUntil` is only meaningful for `cooldown` state, otherwise `null`
- `lastStateReason` is the primary operator-facing explanation string

### 6.3 Provider-group summary fields

The existing `providersSummary` object should be extended to expose the fields needed for quick diagnosis:

- `totalCount`
- `healthyCount`
- `disabledCount`
- `unhealthyCount`
- `cooldownCount`
- `bannedCount`
- `riskyCount`
- `authFailureCount`
- `rateLimitFailureCount`
- `nextCooldownUntil`
- `totalUsage`
- `totalErrors`
- `selectableCount`
- `busyCount`
- `previewNodes`

Definitions:

- `selectableCount`: nodes currently allowed by state rules and not disabled
- `busyCount`: nodes with `activeRequests > 0` or `waitingRequests > 0`
- `authFailureCount`: nodes whose most recent normalized failure is `auth`
- `rateLimitFailureCount`: nodes whose most recent normalized failure is `rate_limit`

### 6.4 Preview node payload

`previewNodes` should remain lightweight. It should contain only the fields required for summary cards and modal previews:

- `uuid`
- `customName`
- `state`
- `isSelectable`
- `stateScore`
- `cooldownUntil`
- `recentFailureType`
- `lastStateReason`
- `usageCount`
- `errorCount`
- `activeRequests`
- `waitingRequests`

### 6.5 Sanitization rules

The current masking behavior for secret-like fields must remain unchanged.

This iteration must not expose raw tokens, credentials, or unmasked sensitive config values. Scheduler visibility is limited to runtime health/selection metadata and request counters.

## 7. Frontend Design

### 7.1 Placement

Do not create a separate scheduler page in this iteration.

Use the existing views:

- Dashboard summary cards
- Provider list cards
- Provider detail modal / panel

### 7.2 Dashboard behavior

For each provider group card, show:

- total nodes
- healthy nodes
- cooldown (`429`) nodes
- auth-risk (`401/403`) nodes
- disabled nodes
- next cooldown recovery time

The dashboard goal is to answer: "Which groups are degraded right now?"

### 7.3 Provider list behavior

For each provider group row or card, surface:

- selectable node count
- total errors
- current runtime breakdown
- short cooldown hint when applicable

The provider list goal is to answer: "Which group is usable, degraded, or blocked?"

### 7.4 Node detail behavior

For each node detail entry, surface:

- runtime state badge
- selectable / non-selectable marker
- recent failure type badge
- cooldown remaining or cooldown timestamp
- last state reason
- active/waiting request counters
- usage count / error count / consecutive failures
- state score

The node detail goal is to answer: "Why is this node currently chosen, skipped, or degraded?"

### 7.5 UI guardrails

To keep the UI usable:

- summary views should prefer compact badges and counts
- long diagnostic strings should stay in secondary text or tooltips
- avoid chart libraries in this iteration
- avoid adding polling beyond the current provider refresh behavior

## 8. Data Flow

1. Provider runtime state continues to be maintained by `ProviderPoolManager`
2. `provider-api.js` reads current runtime config and derives additional scheduler visibility fields
3. The UI fetches existing provider endpoints as it already does
4. The UI renders richer state summaries without changing core routing logic

No change is required to request forwarding flow or provider selection order in this iteration.

## 9. Error Handling

### Backend

- If some runtime fields are missing, respond with `null` or derived defaults instead of failing the whole response
- Keep summary endpoints resilient when provider pool files contain partially stale nodes

### Frontend

- Missing scheduler fields should degrade gracefully to empty badges or hidden sections
- Do not block provider management actions when observability metadata is absent

## 10. Testing Strategy

### Backend tests

Add or extend tests covering:

- summary response includes new scheduler fields
- node payload exposes `isSelectable`, `stateScore`, and failure classification safely
- cooldown/auth counters aggregate correctly
- missing runtime fields do not break summary output

### Frontend tests

Add or extend tests covering:

- runtime state display renders the new summary counts correctly
- cooldown/auth breakdown renders only when counts are present
- node details hide gracefully when optional fields are absent

### Manual verification

Manual validation should confirm:

- `429` nodes show cooldown timing clearly
- `401/403` nodes are distinguishable from generic risky nodes
- operator can tell whether a node is selectable without reading source code
- existing provider pages remain responsive and readable

## 11. Rollout Plan

Phase 1:

- Extend API payloads and backend tests

Phase 2:

- Update provider/dashboard UI rendering

Phase 3:

- Validate with mixed healthy, cooldown, banned, and disabled pools

## 12. Success Criteria

This iteration is successful if:

- the dashboard can immediately show which provider groups are degraded
- the provider list can show whether a group still has selectable capacity
- the node detail can explain why a specific node is unavailable
- no scheduler policy rewrite is required to get this visibility

## 13. Follow-Up Work

The next logical steps after this design, if needed, are:

1. scheduler event timeline/history
2. bulk management API for batch operations
3. route alias and model mapping productization

Those are intentionally out of scope for this iteration.
