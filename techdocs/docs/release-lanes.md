# Release lanes

The release system defines six lanes for develop and five for main so each
change crosses only the authority it needs:

- **Bootstrap** installs the deployment control plane and its bounded roles.
- **Foundation** manages shared networking, signing, and runtime foundations.
- **Toolchain** builds and promotes the immutable RISC Zero toolchain image.
- **Prover** builds and promotes the immutable prover image while preserving
  the ImageID and signature trust chain.
- **App full** reviews and applies application infrastructure and deployable
  artifacts.
- **App static-fast** is available only on develop. It publishes presentation-only
  frontend changes and remains default-deny for server or infrastructure changes.

Candidate creation and promotion are separate. No lane treats a branch head,
mutable tag, or latest object as release authority.
