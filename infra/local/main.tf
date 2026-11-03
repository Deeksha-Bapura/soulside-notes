# Free local cluster: a single-node kind (Kubernetes-in-Docker) cluster plus
# Traefik as the Ingress controller. Needs only Docker Desktop.
#
#   terraform init && terraform apply
#   -> then deploy the app with scripts/deploy-local.ps1

terraform {
  required_version = ">= 1.6"

  required_providers {
    kind = {
      source  = "tehcyx/kind"
      version = "~> 0.13"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3"
    }
  }
}

provider "kind" {}

resource "kind_cluster" "this" {
  name           = var.cluster_name
  node_image     = var.node_image
  wait_for_ready = true

  kind_config {
    kind        = "Cluster"
    api_version = "kind.x-k8s.io/v1alpha4"

    node {
      role = "control-plane"

      # Same log rotation as the Compose `logging:` blocks (10 MB x 3 files),
      # applied by the kubelet to every container on the node.
      kubeadm_config_patches = [
        <<-YAML
        kind: KubeletConfiguration
        containerLogMaxSize: 10Mi
        containerLogMaxFiles: 3
        YAML
      ]

      # Traefik listens on NodePort 30080 inside the node container; publish it
      # on the host the way Compose published the proxy on 8000.
      extra_port_mappings {
        container_port = 30080
        host_port      = var.http_port
        listen_address = "127.0.0.1"
        protocol       = "TCP"
      }
    }
  }
}

provider "helm" {
  kubernetes = {
    host                   = kind_cluster.this.endpoint
    client_certificate     = kind_cluster.this.client_certificate
    client_key             = kind_cluster.this.client_key
    cluster_ca_certificate = kind_cluster.this.cluster_ca_certificate
  }
}

# Traefik as the Ingress controller. (ingress-nginx, the usual choice, was
# retired by the Kubernetes project in March 2026 and no longer gets security
# fixes.) Traefik proxies WebSocket upgrades with no extra configuration.
resource "helm_release" "traefik" {
  name             = "traefik"
  repository       = "https://traefik.github.io/charts"
  chart            = "traefik"
  version          = var.traefik_chart_version
  namespace        = "traefik"
  create_namespace = true
  wait             = true

  # Same values the CI smoke test uses.
  values = [file("${path.module}/../../deploy/traefik-values.yaml")]
}
