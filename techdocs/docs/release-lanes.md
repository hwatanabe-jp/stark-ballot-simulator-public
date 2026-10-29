# Release lanes

The source defines four managed pipelines and thirteen build projects per
target: twelve pipeline projects and one asynchronous App status publisher.
Bootstrap changes use a protected local saved-plan workflow; drift is local
and read-only. Target rollout is verified separately.

- **Foundation** manages shared networking, signing, and runtime foundations.
- **Toolchain** builds and promotes the immutable RISC Zero toolchain image.
- **Prover** builds and promotes the immutable prover image while preserving
  the ImageID and signature trust chain.
- **App** prepares the complete saved plan, requires one approval, then applies
  application infrastructure and publishes the frontend, smoke evidence and
  checkpoint within one queued stage. Frontend-only changes use this lane.
  Status publication runs asynchronously after App success and can lag or fail
  independently.

Candidate creation and promotion are separate. Each lane requires the reviewed
source and release evidence; a branch head, mutable tag, or latest object alone
cannot authorize a release.

The Public Specs describe [Terraform and deployment management](https://specs.stark-ballot-sim.hwatanabe.dev/aws/terraform.html).
