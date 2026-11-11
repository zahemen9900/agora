data "aws_vpc" "default" {
  default = true
}

data "aws_subnet" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }

  filter {
    name   = "availability-zone"
    values = [var.availability_zone]
  }

  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

locals {
  vpc_id    = data.aws_vpc.default.id
  subnet_id = data.aws_subnet.default.id
}

resource "aws_security_group" "api" {
  name        = "agora-api"
  description = "Agora API ingress: HTTPS and ACME HTTP only"
  vpc_id      = local.vpc_id

  ingress {
    description = "HTTP for ACME and redirect"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS API and dashboard"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Outbound HTTPS for model providers, S3, ECR, SSM, and ACME"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "agora-api"
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/agora/${var.environment}/api"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "sandbox" {
  name              = "/agora/${var.environment}/sandbox"
  retention_in_days = var.log_retention_days
}
