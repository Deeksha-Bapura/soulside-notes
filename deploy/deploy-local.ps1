<#
.SYNOPSIS
  Build the Soulside Notes images and deploy them to the local kind cluster.

.DESCRIPTION
  Run from the repo root after `terraform apply` in infra/local:
    .\deploy\deploy-local.ps1

  1. Builds the api and web images with a fresh tag
  2. Loads them into the kind cluster (kind can't see your local Docker images otherwise)
  3. Installs or upgrades the Helm release, waiting for every pod to be Ready
  4. Runs the chart's smoke test
  Then open http://localhost:8080
#>
param(
  [string]$Cluster   = "soulside",
  [string]$Namespace = "soulside",
  [string]$Release   = "soulside"
)

$ErrorActionPreference = "Stop"

# Native commands (docker, kind, helm) don't throw on failure in PowerShell,
# so check each exit code.
function Invoke-Checked {
  param([string]$Description, [scriptblock]$Command)
  Write-Host "==> $Description" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$Description failed (exit code $LASTEXITCODE)" }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  # A new tag each run makes Helm roll the pods onto the new image.
  $tag = "dev-" + (Get-Date -Format "yyyyMMddHHmmss")

  Invoke-Checked "Build API image"      { docker build -f Dockerfile.api -t "soulside-api:$tag" . }
  Invoke-Checked "Build frontend image" { docker build -f Dockerfile.web -t "soulside-web:$tag" . }
  Invoke-Checked "Load images into kind" { kind load docker-image "soulside-api:$tag" "soulside-web:$tag" --name $Cluster }

  Invoke-Checked "Install/upgrade Helm release" {
    helm upgrade --install $Release deploy/helm/soulside-notes `
      --namespace $Namespace --create-namespace `
      -f deploy/helm/values-local.yaml `
      --set "api.image.tag=$tag" `
      --set "web.image.tag=$tag" `
      --wait --timeout 5m
  }

  Invoke-Checked "Run smoke test" { helm test $Release --namespace $Namespace --logs }

  Write-Host "`nSoulside Notes is running at http://localhost:8080" -ForegroundColor Green
}
finally {
  Pop-Location
}
