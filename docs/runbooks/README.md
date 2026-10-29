# Current Runbooks

Use this directory for incident diagnosis and operational safeguards for the
current implementation. Deployment selection and AWS change application live
in the private deployment-operation guides, not in incident runbooks.

| Runbook                                               | Role                                                                                                                                                                                                                                                   | Use it when                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [AWS Runtime Operations](./aws-runtime-operations.md) | Read-only-first diagnosis of the deployed `stark-dev/develop` edge, API, artifacts, async finalization, async verification, DLQs, Batch capacity and terminal events, IAM/config, and monitoring; defines the escalation boundary for recovery changes | A deployed AWS flow is unavailable, stuck, inconsistent, or suspected of drift     |
| [Logging](./logging.md)                               | Logging controls, sensitive-data rules, and application log troubleshooting                                                                                                                                                                            | Logs are missing, unsafe, or insufficient for diagnosis                            |
| [Security](./security.md)                             | Turnstile, no-WAF compensating controls, rate limits, edge security, and security-response checks                                                                                                                                                      | Abuse controls, admission, direct-origin behavior, or security posture is involved |

For a change identified during diagnosis, use the private operator documentation
to select its lane, obtain approval, and check live inventory and deployment
evidence. The diagnostic steps here grant no change authority.

Related public references:

- [Terraform ownership](../infrastructure/terraform.md) explains the
  bootstrap, foundation, and app state boundaries.
- [System architecture](../architecture/aws-architecture.md) shows the target
  runtime and proof pipeline.
- [Verification implementation](../verification/README.md) is the authority
  for verification semantics and the public/private artifact contract.

The AWS commands in these runbooks remain scoped to `stark-dev/develop`.
Production `stark-prod/main` requires its own target-bound operator procedure
and separate authorization. Historical migration or legacy material is not an
operational authority for the current runtime.
