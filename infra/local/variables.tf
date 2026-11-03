variable "cluster_name" {
  description = "Name of the kind cluster (kubectl context becomes kind-<name>)."
  type        = string
  default     = "soulside"
}

variable "node_image" {
  description = "kind node image, i.e. the Kubernetes version. Default matches kind v0.33's own default."
  type        = string
  default     = "kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5"
}

variable "http_port" {
  description = "Port on your machine that serves the app (http://localhost:<port>)."
  type        = number
  default     = 8080
}

variable "traefik_chart_version" {
  description = "Traefik Helm chart version."
  type        = string
  default     = "42.2.0"
}
