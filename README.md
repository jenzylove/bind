# Bind

Bind turns one goal into a small multi-agent workflow. It plans the crew, calls marketplace services, checks each returned output, synthesizes the passed results, and records a canonical integrity receipt.

Bind is built for the OKX AI Agent Marketplace on X Layer. The current marketplace registration is agent **#4735**.

## Product flow

1. `POST /bind/plan` converts a goal into a two-to-four-step plan and quote.
2. The buyer funds the mission through a supported payment flow.
3. `POST /bind/execute` calls the selected marketplace services in sequence.
4. Bind rejects empty and obvious error outputs. A model-based relevance check adds a semantic gate when available.
5. Passed outputs are synthesized into one result.
6. Bind builds a versioned receipt and submits its hash for anchoring.

Paid service calls use x402. Some agents can return useful output without requesting payment, so a passed step is not automatically evidence that money moved.

Standard EIP-3009 signatures authenticate only token-transfer fields: payer, payee, value, validity window, and nonce. They do not cryptographically sign the HTTP method, URL, query, or POST body. Bind validates one exact x402 v2 envelope and full resource URL, freezes the request after signing, and relies on TLS for transport confidentiality and integrity. A captured valid credential is still bearer-like within its transfer scope until used or expired. Bind does not claim request-body binding.

## What verification means

The structural gate rejects empty responses and common error payloads. The semantic relevance check is fail-open when its model key is unavailable or the check errors. Receipt verdicts record which check ran and its result.

This means a `passed` verdict is execution evidence, not a guarantee that every factual claim in an agent response is correct.

## Receipt proof

Completed executions store a `bind.execution-receipt.v2` core. The core commits to:

- the capability-scoped goal through `goalSha256`, with an explicit warning that SHA-256 is not confidentiality for guessable text
- each selected agent, service, verification policy, dependency failure, and step error
- every recorded primary or fallback call attempt, including input/output commitments, verdict, fee evidence, payment recipient commitment, and seller-supplied settlement reference when available
- incoming buyer payment amount, state, recipient commitment, and valid transaction hash when available
- refund amount due, amount submitted, state, recipient commitment, and valid transaction hash when available
- the final synthesized result through `deliverableSha256`

`GET /bind/receipt/:executionId` returns the canonical receipt, its SHA-256 hash, canonicalization rules, the expected X Layer calldata, and a local self-check against the stored hash.

The proof reports anchor submission evidence separately. On-chain confirmation is not checked by the current receipt endpoint. Legacy receipts are labelled `legacy_unproven` because their original preimage cannot be reconstructed.

## Privacy model

Execution IDs are unguessable capability identifiers. Status responses use a redacted projection that excludes raw goals, payer addresses, endpoints, request bodies, intermediate outputs, attempt internals, and seller errors. The final bundled deliverable remains available to the capability holder. Receipt URLs expose commitments and evidence states rather than raw private artifacts. Mission HTML can contain the buyer's goal and result, so anyone holding that URL can read that mission and buyers must treat it as a secret.

Wallet history is not publicly enumerable. Public agent reputation exposes attempt outcomes, recorded fees, and seller-supplied settlement references, but no customer goal text, wallet address, raw input, raw output, final report, or execution capability URL. Audience-separated evidence IDs derive from random execution UUIDs and are identifiers, not confidentiality claims.

## Evidence states

Bind keeps these states distinct:

| Evidence | Meaning |
|---|---|
| `confirmed` | A canonical USDT transfer was independently matched in a successful X Layer receipt with the exact sender, recipient, and amount |
| `authorized_ambiguous` | A downstream authorization was sent, but exact settlement or non-settlement is not yet proven. Its amount stays reserved and fallback is blocked |
| `submitted` | A transaction hash was returned for a refund or anchor, but that evidence surface has not independently confirmed it on-chain |
| `unconfirmed` | A non-transaction reference or missing chain evidence was recorded |
| `no_payment_required` | The agent returned a successful result without an x402 challenge |
| `none` | No payment or refund evidence exists |

Recorded fee amounts are accounting evidence. They are not called confirmed payments without a valid transaction hash.

## Known release boundary

The current financial path still has release boundaries that must be closed before treating Bind as production-grade custody software:

- Buyer transaction and EIP-3009 authorization claims use durable atomic filesystem records with crash-safe transitions. This prevents concurrent duplicate use, but there is not yet an automatic startup reconciliation worker for every nonterminal claim and ambiguous downstream authorization.
- Incoming onchainos submissions are accepted only after an independent successful X Layer receipt contains the exact canonical USDT transfer. This path has not yet been exercised end to end with a real paid marketplace mission on the target deployment.
- Downstream paid calls are disabled unless `BIND_REVIEWED_DOWNSTREAM_IDENTITIES` contains an exact endpoint and reviewed payee. A signed request gets one exact replay. Missing or invalid independent receipt evidence remains `authorized_ambiguous` and blocks fallback.
- EIP-3009 remains a bearer-style transfer authorization and does not authenticate the HTTP request body.

This branch must not be treated as a production-payment deployment until the complete pay, execute, ambiguous-settlement reconciliation, refund, receipt, restart recovery, and real X Layer paths have been exercised.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

For local tests without buyer payment, set:

```bash
BIND_ALLOW_FREE=1
```

Do not enable that flag in a paid deployment.

Paid downstream calls also require an exact reviewed identity registry:

```bash
BIND_REVIEWED_DOWNSTREAM_IDENTITIES='[{"endpoint":"https://reviewed-seller.example/exact/path","payTo":"0xREVIEWED_40_HEX_ADDRESS"}]'
```

The example is a schema only. Populate it from authenticated marketplace or independently reviewed seller evidence. Bind refuses paid 402 challenges when the endpoint is absent, differs by path/query, or names another payee.

## Quality gates

```bash
npm test
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=high
```

## Stack

- TypeScript, Express, Node.js
- OKX Agentic Wallet and onchainos CLI
- x402 and EIP-3009 payment flows on X Layer, chain ID `196`
- SHA-256 canonical receipt commitments
