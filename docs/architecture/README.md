# System Architecture

This area describes the current educational STARK Ballot Simulator architecture:
its components, execution boundaries, and deployment topology. Production election
architecture and speculative scale-out designs are outside its scope.

## Documents

| Document                                             | Purpose                                                                                                   | Language |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| [AWS architecture](./aws-architecture.md)            | CloudFront/S3 frontend, Hono API, DynamoDB state, asynchronous proof generation, and verification workers | English  |
| [Repository context map](./context-map.md)           | Package ownership, runtime boundaries, and cross-cutting support surfaces                                 | English  |
| [Draw.io source](./aws-architecture-overview.drawio) | Editable source for the AWS runtime and deployment diagrams                                               | Diagram  |

### Diagram export

The draw.io source has two pages that are published as pre-rendered images in
the Public Specs. Keep the source and both images synchronized:

- page 1, `Runtime Architecture` → `public-book/src/aws/images/aws-architecture-overview.png`
- page 2, `Deployment Control` → `public-book/src/aws/images/aws-deployment-control.png`

Export each page as PNG at 2x zoom with a white background and a 40px border
around the diagram content (for example
`drawio -x -f png -p <page> -s 2 -b 40 -o page.png <source>.drawio`), then
trim excess whitespace, restore an even 40px border, and reduce it to a
256-color palette PNG (for example
`convert page.png -trim +repage -bordercolor white -border 40 -strip +dither -colors 256 png8:out.png`)
so the committed images have balanced margins and stay small without visible
quality loss.

The `-p` page index is 1-based: use `-p 1` for Runtime Architecture and
`-p 2` for Deployment Control. Both diagrams summarize separate main and
develop resources; develop-only components are labeled explicitly.

### Diagram conventions

- Keep `Runtime Architecture` focused on request, proof-generation, and verification
  flows; use `Deployment Control` for release lanes, approvals, and authority storage.
  Check both against current implementation and IaC before updating the source and
  both exported images.
- Use AWS service icons to make resource types recognizable, with consistent icon,
  label, line, and legend styles across the two pages.
- Preserve the landscape topology, standalone service icons, AWS Cloud and VPC
  boundaries, and connected resource groups when updating either page.
- Leave clear space between text, icons, connectors, and group headings. Align
  connection points so straight connectors stay straight; remove small unnecessary
  steps and bends. Use line jumps only to distinguish crossings from connections.
- Balance spacing inside groups and keep the 40px export border clear on all four
  sides, including the corners.
- Inspect the exported PNGs both at the Public Specs inline width and at full scale
  for readable labels, correct connections, clipping, overlaps, and palette artifacts.

## Current System Shape

```text
Browser
  -> Vite / React Router application
  -> CloudFront
     -> private S3 static frontend
     -> API Gateway REST API
        -> Hono public-api Lambda
           -> DynamoDB session and vote state
           -> append-only bulletin evidence
           -> SQS / Step Functions / AWS Batch / Fargate prover pipeline
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

Hono is the retained API runtime. The schema-carrying route inventory is
`packages/api-contract/src/routes/inventory.ts`;
`apps/api/src/server/api/routes/definitions.ts` selects runtime route sets, and
`apps/api/src/server/api/routes/hono.ts` binds handlers and performs transport
admission. Request behavior belongs in `apps/api/src/server/api/handlers/` and
reusable packages.

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
