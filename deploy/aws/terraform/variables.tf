variable "aws_account_id" {
  description = "AWS account that Terraform is allowed to modify."
  type        = string
  default     = "866160682016"
}

variable "aws_region" {
  description = "AWS region for the Agora backend."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "prod"
}

variable "data_bucket_name" {
  description = "Private S3 bucket for tasks, workspaces, API keys, sources, and benchmarks."
  type        = string
  default     = "agora-866160682016-data"
}

variable "github_repo" {
  description = "GitHub repository allowed to deploy through OIDC."
  type        = string
  default     = "zahemen9900/agora"
}

variable "github_deploy_refs" {
  description = "Git refs allowed to assume the GitHub deploy role. Keep this main-only outside migration windows."
  type        = list(string)
  default     = ["ref:refs/heads/main"]
}

variable "availability_zone" {
  description = "Availability zone used for the single production host."
  type        = string
  default     = "us-east-1a"
}

variable "instance_type" {
  description = "EC2 instance type for the production host."
  type        = string
  default     = "t3a.small"
}

variable "enable_compute" {
  description = "Create the EC2 host. Keep false until secrets, images, and the initial release bundle exist."
  type        = bool
  default     = false
}

variable "initial_release_sha" {
  description = "Immutable release SHA to stage on first boot."
  type        = string
  default     = ""
}

variable "initial_release_checksum" {
  description = "SHA-256 checksum of the initial release bundle."
  type        = string
  default     = ""
}

variable "budget_notification_email" {
  description = "Email address for AWS Budget notifications. Leave empty to skip the budget."
  type        = string
  default     = "davidzahemenyeboah@signify-ai.org"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for Agora log groups."
  type        = number
  default     = 7
}

variable "frontend_origins" {
  description = "Exact browser origins allowed to upload sources directly to S3."
  type        = list(string)
  default = [
    "https://agora-bay-seven.vercel.app",
    "https://agora-dashboard.vercel.app",
  ]
}
