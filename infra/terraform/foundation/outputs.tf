output "foundation_state_identity" {
  description = "Foundation Terraform state identity."
  value       = local.foundation_lane_authority.stateIdentity
}

output "foundation_state_backend_key" {
  description = "Expected backend key for foundation state."
  value       = local.expected_state_backend_key
}

output "target_image_authority" {
  description = "Target image authority repository names and policy summary."
  value = {
    toolchain_repository_name      = aws_ecr_repository.toolchain.name
    toolchain_repository_url       = aws_ecr_repository.toolchain.repository_url
    prover_repository_name         = aws_ecr_repository.prover.name
    prover_repository_url          = aws_ecr_repository.prover.repository_url
    tag_mutability                 = "IMMUTABLE"
    scan_on_push                   = true
    prover_signing_status_required = "COMPLETE"
    signing_profile_name           = aws_signer_signing_profile.ecr.name
    signing_profile_arn            = aws_signer_signing_profile.ecr.arn
    signing_repository_filters = [
      for repository_name in local.ecr_signing_repository_filters : {
        filter     = repository_name
        filterType = "WILDCARD_MATCH"
      }
    ]
    retention_policy = "newest-five-images"
  }
}

output "release_manifest_authority" {
  description = "Encrypted versioned S3 authority for immutable candidates and versioned promotions."
  value = {
    bucket_name                        = aws_s3_bucket.release_manifests.bucket
    versioning_enabled                 = true
    encryption                         = "AES256"
    immutable_record_delete_protection = true
    required_coordinates               = ["key", "versionId", "sha256"]
    consumer_model                     = "versioned-promotion-to-exact-candidate"
  }
}

output "runtime_reference_names" {
  description = "Non-secret target runtime reference names created or reserved by foundation."
  value       = local.runtime_reference_names
}

output "prover_networking" {
  description = "Foundation-owned prover networking inputs for the app handoff."
  value = {
    vpc_id                  = aws_vpc.prover.id
    prover_subnet_ids       = aws_subnet.prover[*].id
    prover_security_groups  = [aws_security_group.prover.id]
    network_authority       = "foundation-owned"
    public_subnet_exception = local.foundation_public_subnet_exception
  }
}

output "public_hostname_disposition" {
  description = "Public-hostname disposition carried into the release-candidate handoff."
  value = {
    disposition = var.public_hostname_disposition
  }
}

# Owning Smoke admits these resource-derived Apply outputs before publication.
# Consumers compare this small projection; implementation files are not hashed.
output "consumer_requirements" {
  description = "Foundation settings required by App and image consumers."
  value = {
    networking = {
      dnsHostnames         = aws_vpc.prover.enable_dns_hostnames
      dnsSupport           = aws_vpc.prover.enable_dns_support
      ingress              = [for rule in aws_security_group.prover.ingress : rule.protocol]
      ipv4Egress           = sort(flatten([for rule in aws_security_group.prover.egress : rule.cidr_blocks]))
      ipv6Egress           = sort(flatten([for rule in aws_security_group.prover.egress : rule.ipv6_cidr_blocks]))
      allProtocolsEgress   = alltrue([for rule in aws_security_group.prover.egress : rule.protocol == "-1" && rule.from_port == 0 && rule.to_port == 0 && !rule.self && length(rule.security_groups) == 0 && length(rule.prefix_list_ids) == 0])
      egressRuleCount      = length(aws_security_group.prover.egress)
      publicSubnets        = alltrue([for subnet in aws_subnet.prover : subnet.map_public_ip_on_launch])
      subnetCount          = length(aws_subnet.prover)
      securityGroupCount   = length([aws_security_group.prover.id])
      subnetsInVpc         = alltrue([for subnet in aws_subnet.prover : subnet.vpc_id == aws_vpc.prover.id])
      securityGroupInVpc   = aws_security_group.prover.vpc_id == aws_vpc.prover.id
      internetGatewayRoute = aws_internet_gateway.prover.vpc_id == aws_vpc.prover.id && aws_route_table.prover.vpc_id == aws_vpc.prover.id && anytrue([for route in aws_route_table.prover.route : route.cidr_block == "0.0.0.0/0" && route.gateway_id == aws_internet_gateway.prover.id]) && alltrue([for index, association in aws_route_table_association.prover : association.route_table_id == aws_route_table.prover.id && association.subnet_id == aws_subnet.prover[index].id])
    }
    images = {
      tagMutability               = aws_ecr_repository.prover.image_tag_mutability == aws_ecr_repository.toolchain.image_tag_mutability ? aws_ecr_repository.prover.image_tag_mutability : "mismatch"
      scanOnPush                  = aws_ecr_repository.prover.image_scanning_configuration[0].scan_on_push && aws_ecr_repository.toolchain.image_scanning_configuration[0].scan_on_push
      proverSigningStatusRequired = "COMPLETE"
      retentionPolicy             = "newest-five-images"
    }
  }
}
