data "aws_ami" "al2023" {
  count       = var.enable_compute ? 1 : 0
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

resource "aws_eip" "api" {
  count  = var.enable_compute ? 1 : 0
  domain = "vpc"

  tags = {
    Name = "agora-api"
  }
}

resource "aws_instance" "api" {
  count = var.enable_compute ? 1 : 0

  ami                         = data.aws_ami.al2023[0].id
  instance_type               = var.instance_type
  subnet_id                   = local.subnet_id
  vpc_security_group_ids      = [aws_security_group.api.id]
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  associate_public_ip_address = false
  user_data_replace_on_change = true

  user_data = templatefile("${path.module}/templates/user_data.sh.tftpl", {
    aws_region               = var.aws_region
    data_bucket              = aws_s3_bucket.data.bucket
    initial_release_sha      = var.initial_release_sha
    initial_release_checksum = var.initial_release_checksum
  })

  root_block_device {
    volume_size           = 30
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = false
  }

  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  lifecycle {
    precondition {
      condition     = var.initial_release_sha != "" && var.initial_release_checksum != ""
      error_message = "Set initial_release_sha and initial_release_checksum before enabling compute."
    }
  }

  tags = {
    Name          = "agora-api"
    AgoraInstance = "true"
  }
}

resource "aws_eip_association" "api" {
  count = var.enable_compute ? 1 : 0

  instance_id   = aws_instance.api[0].id
  allocation_id = aws_eip.api[0].id
}
