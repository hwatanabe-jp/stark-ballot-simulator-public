# System Architecture

This area explains the current STARK Ballot Simulator structure. It describes
the educational proof of concept that exists today; it is not a production
election architecture or a speculative scale-out design.

## Documents

| Document                                             | Purpose                                                                                                   | Language    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------- |
| [AWS architecture](./aws-architecture.md)            | CloudFront/S3 frontend, Hono API, DynamoDB state, asynchronous proof generation, and verification workers | 🇯🇵 Japanese |
| [Repository context map](./context-map.md)           | Package ownership, runtime boundaries, and cross-cutting support surfaces                                 | 🇬🇧 English  |
| [Draw.io source](./aws-architecture-overview.drawio) | Editable source for the AWS overview diagram                                                              | Diagram     |

### Diagram export

The draw.io source has two pages that are published as pre-rendered images in
the Public Specs. Keep the source and both images synchronized:

- page `Runtime Architecture` → `public-book/src/aws/images/aws-architecture-overview.png`
- page `Deployment Control` → `public-book/src/aws/images/aws-deployment-control.png`

Export each page as PNG at 2x zoom with a white background, cropped to the
diagram content, then reduce it to a 256-color palette PNG (for example
`convert page.png -strip +dither -colors 256 png8:out.png`) so the committed
images stay small without visible quality loss.

## Current System Shape

```text
Browser
  -> Vite / React Router application
  -> CloudFront
     -> private S3 static frontend
     -> API Gateway HTTP API
        -> Hono public-api Lambda
           -> DynamoDB session and vote state
           -> append-only bulletin evidence
           -> SQS / Step Functions / ECS prover pipeline
           -> verification-worker Lambda
           -> private proof and report storage
```

The proof and verification model is deliberately inspectable:

- voters receive commitments and inclusion evidence;
- the bulletin board uses RFC 6962-style append-only proofs;
- the zkVM journal binds the verified tally to election, bulletin, bitmap,
  and input-commitment data; and
- the UI may show `Verified` only after every required check succeeds.

## Hono API Boundary

Hono is the retained API runtime. The framework-neutral route inventory is
`apps/api/src/server/api/routes/definitions.ts`; Hono binding lives in
`apps/api/src/server/api/routes/hono.ts`; request behavior belongs in
`apps/api/src/server/api/handlers/` and reusable packages.

Session-scoped operations require capability-token validation. Deployment
values must remain placeholders in public documentation, and operational
evidence is kept outside this public architecture area.

## PoC Boundaries

- This repository demonstrates verifiability, not production election
  hardening.
- Some demo paths allow the operator to retain vote-opening data.
- Educational tamper scenarios make failures observable; they are not an
  adversarial deployment model.
- `RISC0_DEV_MODE=1` produces development receipts, not production STARK
  proofs.

## Related Documentation

- [Verification pipeline](../verification/README.md)
- [zkVM design and evidence](../zkvm/README.md)
- [Infrastructure ownership](../infrastructure/README.md)
- [Runtime runbooks](../runbooks/README.md)
- [UI contracts](../ui/README.md)
