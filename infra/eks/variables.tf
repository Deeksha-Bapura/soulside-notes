variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "cluster_name" {
  description = "EKS cluster name (also used to name the VPC and IAM roles)."
  type        = string
  default     = "soulside"
}

variable "kubernetes_version" {
  description = "EKS Kubernetes version. 1.37 is in standard support until Dec 2027."
  type        = string
  default     = "1.37"
}

variable "node_instance_type" {
  description = "Instance type for the managed node group."
  type        = string
  default     = "t3.medium"
}

variable "node_count" {
  description = "Desired number of worker nodes."
  type        = number
  default     = 2
}

variable "app_namespace" {
  description = "Namespace the Helm chart is deployed into. CI's deploy role is limited to it."
  type        = string
  default     = "soulside"
}

variable "github_repository" {
  description = "GitHub repo (owner/name, exact case) allowed to deploy via OIDC."
  type        = string
  default     = "Deeksha-Bapura/soulside-notes"
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub Actions OIDC provider. Set false if your AWS account already has one (only one is allowed per account)."
  type        = bool
  default     = true
}

variable "aws_lb_controller_chart_version" {
  description = "AWS Load Balancer Controller Helm chart version."
  type        = string
  default     = "3.6.2"
}
