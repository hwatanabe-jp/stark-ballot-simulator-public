# Current Runbooks

Use this directory for incident diagnosis and operational safeguards for the
current implementation. Deployment selection and AWS change application live
in the private deployment-operation guides, not in incident runbooks.

| Runbook                                               | Role                                                                                                                                                                                                                          | Use it when                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [AWS Runtime Operations](./aws-runtime-operations.md) | Read-only-first diagnosis of the deployed `stark-dev/develop` edge, API, artifacts, async finalization, async verification, DLQs, semaphore, IAM/config, and monitoring; defines the escalation boundary for recovery changes | A deployed AWS flow is unavailable, stuck, inconsistent, or suspected of drift     |
| [Logging](./logging.md)                               | Logging controls, sensitive-data rules, and application log troubleshooting                                                                                                                                                   | Logs are missing, unsafe, or insufficient for diagnosis                            |
| [Security](./security.md)                             | Turnstile, no-WAF compensating controls, rate limits, edge security, and security-response checks                                                                                                                             | Abuse controls, admission, direct-origin behavior, or security posture is involved |

These public runbooks support diagnosis; they do not select or authorize a
change. Lane selection, approvals, live inventory, and post-deployment evidence
remain in private operator documentation.

Related public references:

- [Terraform ownership](../infrastructure/terraform.md) explains the
  bootstrap, foundation, and app state boundaries.
- [System architecture](../architecture/aws-architecture.md) shows the target
  runtime and proof pipeline.
- [Verification implementation](../verification/README.md) is the authority
  for verification semantics and the public/private artifact contract.

`stark-prod/main` has not been deployed, validated, or approved. The develop
runbooks and commands are not production procedures. Historical migration or
legacy material is not an operational authority for the current runtime.
