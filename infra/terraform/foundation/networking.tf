data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "prover" {
  cidr_block           = "10.42.0.0/20"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-prover"
  })
}

resource "aws_subnet" "prover" {
  count = 2

  vpc_id                  = aws_vpc.prover.id
  cidr_block              = cidrsubnet(aws_vpc.prover.cidr_block, 4, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-prover-${count.index + 1}"
  })
}

resource "aws_internet_gateway" "prover" {
  vpc_id = aws_vpc.prover.id

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-prover"
  })
}

resource "aws_route_table" "prover" {
  vpc_id = aws_vpc.prover.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.prover.id
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-prover"
  })
}

resource "aws_route_table_association" "prover" {
  count = length(aws_subnet.prover)

  subnet_id      = aws_subnet.prover[count.index].id
  route_table_id = aws_route_table.prover.id
}

resource "aws_security_group" "prover" {
  name        = "${local.name_prefix}-prover"
  description = "Foundation-owned security group for target prover tasks"
  vpc_id      = aws_vpc.prover.id

  egress {
    description = "Allow prover tasks to reach AWS APIs and public package/image endpoints"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-prover"
  })
}
