output "kubectl_context" {
  description = "kubectl context for the cluster (already written to your kubeconfig by kind)."
  value       = kind_cluster.this.context_name
}

output "app_url" {
  description = "Where the app is served once the Helm chart is installed."
  value       = "http://localhost:${var.http_port}"
}
