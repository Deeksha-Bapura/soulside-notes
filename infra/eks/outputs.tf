output "cluster_name" {
  value = module.eks.cluster_name
}

output "region" {
  value = var.region
}

output "configure_kubectl" {
  description = "Point kubectl at the new cluster."
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${module.eks.cluster_name}"
}

output "github_actions_role_arn" {
  description = "Save as the AWS_DEPLOY_ROLE_ARN secret in the GitHub repo's production environment."
  value       = aws_iam_role.github_actions.arn
}
