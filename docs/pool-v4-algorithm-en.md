# Serverless Queue Matching Algorithm · pool-v4-dual-pool (English)

> **Rules version**: `pool-v4-dual-pool`  
> **Reference implementation**: [`shared/pool-rules.js`](../shared/pool-rules.js), [`shared/pool-config.js`](../shared/pool-config.js), [`shared/exit-pay-verify.js`](../shared/exit-pay-verify.js)  
> **Chinese version**: [pool-v4-algorithm-zh.md](./pool-v4-algorithm-zh.md)

---

## 1. Design goals

This algorithm powers **Scheme A: serverless queue matching**. Any participant can reproduce the same queue, match, and payment-verification results using only public rules and on-chain data.

| Principle | Description |
|-----------|-------------|
| Publicly verifiable | Rules and engine source may be published on GitHub; anyone can replay |
| On-chain truth | Ticket purchases and exit-pool payments are verified via TronGrid mainnet txs |
| No user self-report | No testnet anchors; “I have paid” means refresh TronGrid only |
| Dual pools | **Pay pool** and **receive pool** are separate; buying a ticket ≠ becoming a receiver |
| Incremental replay | Completed / expired / blocked entries are archived in snapshots to avoid full-history recomputation |

---

## 2. Core concepts

### 2.1 Dual-pool model

```mermaid
flowchart LR
  A[Buy ticket 100 TRX] --> B[Pay pool pay_queued]
  B --> C{Daily match}
  C --> D[pay_in to exit pool]
  D --> E{Mainnet verify}
  E -->|Pass| F[Receive pool recv_queued]
  E -->|24h timeout| G[pay_expired archived]
  F --> H[recv_out in exitAmountTrx units]
  H --> I[Exit pool pays users]
```

- **Pay pool**: After buying a ticket, users wait to be selected to fund the overflow portion of the daily match.
- **Exit pool**: A fixed mainnet collection address that receives pay-pool outflows; after verification, the payer enters the receive pool.
- **Receive pool**: Verified users queue for exit payouts in whole **`exitAmountTrx`** units (e.g. 3,900 TRX on the 3000 tier).

### 2.2 Buying a ticket ≠ being a receiver

Paying `ticketPriceTrx` (e.g. 100 TRX) to `purchaseAddress` only credits `poolCreditTrx` (e.g. 3,000) into the pool ledger. It does **not** make the user a receiver. The user must complete exit-pool payment and pass mainnet verification first.

### 2.3 Exit pool address

All three tiers share this default mainnet exit pool:

```
TRjvctzrc5WcEeu2UrT8mV5H6zW8dCgimR
```

Override via `POOL_EXIT_ADDRESS` or per-tier `POOL_EXIT_3000`, etc.

---

## 3. Tier configuration (3000 tier example)

| Field | Value | Meaning |
|-------|-------|---------|
| `ticketPriceTrx` | 100 | TRX paid to buy a ticket |
| `poolCreditTrx` | 3,000 | Credit added to the pool ledger |
| `poolTargetTrx` | 300,000 | Pool fill threshold |
| `exitAmountTrx` | 3,900 | TRX received per exit slot |
| `purchaseAddress` | On-chain config | Ticket purchase address |
| `exitPoolAddress` | See above | Exit payment destination |

Tiers 30000 and 300000 scale proportionally; see `POOL_PURCHASE_CONFIG` in `pool-config.js`.

---

## 4. Global constants

| Constant | Value | Description |
|----------|-------|-------------|
| `ENTRY_PERIOD_DAYS` | 15 | Must wait 15 days after first valid ticket before matching |
| `MATCH_PAYMENT_TIMEOUT_HOURS` | 24 | Deadline for pay_in exit-pool payment |
| `MAX_OPEN_ENTRIES_PER_PAYER` | 1 | At most one open entry per payer address |
| `DAILY_MATCH_UTC_HOUR` | 0 | Daily match at UTC 00:00 (Beijing 08:00) |
| `MATCHES_PER_DAY` | 1 | Exactly one match per calendar day |

---

## 5. Entry state machine

| Status | Pool | Meaning |
|--------|------|---------|
| `pay_queued` | Pay | Ticket bought; waiting to be selected as payer |
| `pay_pending` | Pay | pay_in task issued; must pay exit pool |
| `pay_expired` | Archived | Exit payment timed out |
| `recv_queued` | Receive | Mainnet verification passed; waiting for recv_out |
| `recv_partial` | Receive | Remainder not yet reaching exitAmount; carries to next day |
| `recv_pending` | Receive | Full exit slot allocated; awaiting on-chain receipt |
| `done` | Archived | Exit completed |
| `blocked` | Archived | Violation (e.g. duplicate open entry) |
| `consumed` | Archived | Credit consumed |

**Frozen statuses** (no rollback): `pay_pending`, `pay_expired`, `recv_*`, `done`, `consumed`, `blocked`.

---

## 6. Inputs

The replay engine `runPoolCycle` requires:

1. **`purchaseTxs`**: Transfers to `purchaseAddress` with amount equal to `ticketPriceTrx`.
2. **`exitPoolTxs`**: Transfers to `exitPoolAddress` with amount **not** equal to the ticket price.
3. **`snapshot`** (optional): Previous checkpoint for incremental replay.
4. **`nowMs`**: Wall-clock evaluation time (verification window and expiry).

Deterministic tx ordering:

```
blockNumber ↑ → blockTimestamp ↑ → txHash lexicographic ↑
```

Address comparison must normalize Base58 (`T…`) and hex (`41…`) forms.

---

## 7. Ledger and match eligibility

### 7.1 Pool credit ledger

```
ledgerBalance = Σ(poolCreditTrx of entries not in blocked/pay_expired/done)
              − Σ(historical matchedCreditTrx)
```

### 7.2 Can match today (`canMatch`)

All of the following must hold:

1. `ledgerBalance >= poolTargetTrx` (pool full)
2. At least `ENTRY_PERIOD_DAYS` since the first valid entry
3. `overflow = ledgerBalance − poolTargetTrx > 0` (only overflow is matched)

The target amount (e.g. 300,000) is **not** consumed by matching; only overflow is deployed.

---

## 8. Daily match algorithm (UTC 00:00)

For each match day `dayStartMs`, execute in order:

### Step 1 — Merge ticket purchases

- Full replay: all purchases with `blockTimestamp <= dayStartMs`.
- Incremental replay: only new purchases with `snapshotAtMs < blockTimestamp <= dayStartMs`.

### Step 2 — Lifecycle (one open entry per payer)

If a `payer` already has an open entry, subsequent tickets are marked `blocked` with reason: `一次只能排一单` (one queue entry at a time).

### Step 3 — Mainnet payment verification

For `pay_pending` entries, verify against `exitPoolTxs` within `[matchAtMs, evaluationMs]`:

- All pay_in tasks matched → `recv_queued`, store `verifiedMainnetTxId`
- Past `deadlineMs` without full payment → `pay_expired`

See Section 9 for verification rules.

### Step 4 — If `canMatch`, produce match output

#### 8.1 Select payers (from tail of pay pool)

From `pay_queued`, walk **backward** from the tail, accumulating `remainingPoolCreditTrx` until sum ≥ `overflow`.

Selected payers receive **pay_in** tasks:

```
assignmentId = pay_{matchDayId}_{entryId}
channel      = pay_in
amountTrx    = payer's available credit
collector    = exitPoolAddress
deadlineMs   = matchAtMs + 24h
```

Corresponding entries → `pay_pending`.

#### 8.2 Receive pool allocation (recv_out)

Apply `overflow` to `recv_partial` carryovers first, then allocate whole `exitAmountTrx` slots to the front of `recv_queued`:

| Case | Handling |
|------|----------|
| Full exitAmount slot | `recv_pending` |
| Remainder to next receiver | `recv_partial`, store `exitRemainderTrx` |
| Remainder with no receiver | Refund to `purchaseAddress` (`ticket_surplus`) |

#### 8.3 Accounting

```
matchedCreditTrx = Σ(pay_in.amountTrx) + Σ(ticket_surplus.amountTrx)
```

Append a summary to `matchDays` for ledger deduction on later days.

---

## 9. Exit-pool mainnet verification

Function: `derivePayVerifications(payAssignments, exitPoolTxs, exitPoolAddress, evaluationMs)`

For all pay_in tasks of the same `payerEntryId`:

| Criterion | Requirement |
|-----------|-------------|
| From address | `fromAddress` = task `payer` |
| To address | `toAddress` = `exitPoolAddress` (when present on-chain) |
| Amount | Equals `amountTrx` (4 decimal places) |
| Time | `matchAtMs <= blockTimestamp <= evaluationMs` |
| Dedup | Each on-chain tx used at most once globally |

All tasks matched → verified; any deadline passed without full payment → `pay_expired`.

**Do not use** testnet, user-submitted tx hashes, or WSS push as verification sources.

---

## 10. Checkpoint snapshots (incremental replay)

Archived statuses: `done`, `pay_expired`, `blocked` are omitted from `activeEntries`; `blockedPayers` is retained.

Snapshot fields:

- `rulesVersion`, `poolId`, `snapshotAtMs`
- `activeEntries`, `matchDays`
- `blockedPayers`, `usedExitTxIds`, `lastQueueIndex`

Incremental replay:

- Fetch only purchases after `snapshotAtMs`
- Resume match loop from `lastMatchDayMs + 1 day`
- Complexity ≈ O(new days + new entries), not O(full history)

---

## 11. API entry points

```javascript
const { runPoolCycle, runAllPools } = require('./shared/pool-rules');

const result = runPoolCycle({
  poolId: '3000',
  purchaseTxs,      // ticket txs
  exitPoolTxs,      // exit-pool txs
  snapshot,         // optional
  nowMs: Date.now(),
});
```

Key outputs:

| Field | Meaning |
|-------|---------|
| `entries` | All active entries |
| `fill` | Fill ratio, overflow, canMatch |
| `payAssignments` | Today's pay_in tasks |
| `recvAssignments` | Today's recv_out tasks |
| `exitPoolAddress` | Exit pool address |
| `snapshot` | New checkpoint (persist locally on clients) |
| `replayMode` | `full` or `incremental` |

---

## 12. Determinism guarantee

Two parties obtain **identical** `entries`, `payAssignments`, and `recvAssignments` if:

1. Same `rulesVersion`
2. Same purchase + exit-pool tx sets (including pagination completeness and address normalization)
3. Same `nowMs` and starting `snapshot`

This property is why the algorithm is safe to publish on GitHub.

---

## 13. Reference tests

| Test file | Scenario |
|-----------|----------|
| `test-dual-pool-bootstrap.js` | Dual-pool baseline replay |
| `test-pay-verify.js` | Exit-pool verification |
| `test-pay-expired.js` | Payment timeout |
| `test-snapshot-incremental.js` | Same-day incremental snapshot |
| `test-snapshot-next-day.js` | Cross-day incremental snapshot |

Run:

```bash
node shared/test-dual-pool-bootstrap.js
node shared/test-pay-verify.js
node shared/test-pay-expired.js
node shared/test-snapshot-incremental.js
node shared/test-snapshot-next-day.js
```

---

## 14. Client parity

The Flutter client [`Client-flutter`](https://github.com/yongchaoqiu111/Client-flutter) implements:

- `lib/services/pool_engine_service.dart` — Dart engine aligned with this spec
- `lib/services/pool_matcher_service.dart` — TronGrid fetch + local replay
- `lib/services/pool_snapshot_store.dart` — Local snapshot persistence

The rules version string must match `POOL_RULES_VERSION`; otherwise discard old snapshots and run a full replay.

---

*This document tracks the `pool-v4-dual-pool` rules. If ambiguous, `shared/pool-rules.js` is authoritative.*
