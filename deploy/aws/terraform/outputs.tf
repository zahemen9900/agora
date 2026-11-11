output "aws_account_id" {
  description = "AWS account targeted by this configuration."
  value       = data.aws_caller_identity.current.account_id
}

output "data_bucket" {
  description = "Private S3 bucket for durable application data."
  value       = aws_s3_bucket.data.bucket
}

output "api_repository_url" {
  description = "ECR repository URL for the API image."
  value       = aws_ecr_repository.api.repository_url
}

output "sandbox_runner_repository_url" {
  description = "ECR repository URL for the sandbox runner image."
  value       = aws_ecr_repository.sandbox_runner.repository_url
}

output "sandbox_runtime_repository_url" {
  description = "ECR repository URL for the sandbox runtime image."
  value       = aws_ecr_repository.sandbox_runtime.repository_url
}

output "github_deploy_role_arn" {
  description = "Role ARN assumed by GitHub Actions through OIDC."
  value       = aws_iam_role.github_deploy.arn
}

output "instance_role_arn" {
  description = "EC2 instance role ARN."
  value       = aws_iam_role.instance.arn
}

output "instance_profile_name" {
  description = "EC2 instance profile name."
  value       = aws_iam_instance_profile.instance.name
}

output "deploy_document_name" {
  description = "SSM command document used to deploy a release SHA."
  value       = aws_ssm_document.deploy.name
}

output "security_group_id" {
  description = "Security group for the API host."
  value       = aws_security_group.api.id
}

output "vpc_id" {
  description = "VPC used by the API host."
  value       = local.vpc_id
}

output "subnet_id" {
  description = "Public subnet used by the API host."
  value       = local.subnet_id
}

output "availability_zone" {
  description = "Availability zone used by the API host."
  value       = var.availability_zone
}

output "instance_id" {
  description = "EC2 instance ID, or null when compute is disabled."
  value       = try(aws_instance.api[0].id, null)
}

output "elastic_ip" {
  description = "Elastic IP attached to the API host, or null when compute is disabled."
  value       = try(aws_eip.api[0].public_ip, null)
}

output "api_host" {
  description = "Default HTTPS API hostname, or null when compute is disabled."
  value       = try("agora-api.${aws_eip.api[0].public_ip}.nip.io", null)
}

output "api_url" {
  description = "Default HTTPS API URL, or null when compute is disabled."
  value       = try("https://agora-api.${aws_eip.api[0].public_ip}.nip.io", null)
}
