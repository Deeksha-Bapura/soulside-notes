# Kubernetes deployment

The Docker Compose stack, moved to Kubernetes: a Helm chart for the app,
Terraform for the cluster (a free local kind cluster, or EKS), and a GitHub
Actions pipeline that tests every PR on a throwaway cluster and deploys
merges to `main`.

## How the Compose file maps over

| Compose | Kubernetes (Helm chart) |
|---|---|
| `web` service | Deployment (2 replicas) + Service, PodDisruptionBudget |
| `api` service | Deployment + Service. Stays at 1 replica: the WebSocket fan-out lives in process memory |
| `mongo` service + `mongo-data` volume | StatefulSet + PersistentVolumeClaim + headless Service |
| `redis` service + `redis-data` volume | StatefulSet + PersistentVolumeClaim + headless Service |
| `proxy` (nginx, `/api`, `/ws`, `/`) | Ingress: Traefik locally, AWS ALB on EKS, both pass WebSocket upgrades through |
| `secrets: mongo_root_password` | Secret, mounted at the same `/run/secrets/mongo_root_password` path, so `server/db.ts` is unchanged |
| `healthcheck:` | startup, liveness and readiness probes (`/healthz` and `/readyz` on the API) |
| `depends_on: service_healthy` | init container that waits for Mongo and Redis |
| `logging:` json-file 10 MB × 3 | kubelet `containerLogMaxSize: 10Mi`, `containerLogMaxFiles: 3` (set in Terraform) |
| one flat network | NetworkPolicies: only the API can reach Mongo and Redis |

Also new: pods run as non-root with all Linux capabilities dropped, the API
shuts down gracefully on SIGTERM (so rolling updates don't drop requests), and
`helm test` runs an in-cluster smoke test.

```
deploy/
  helm/soulside-notes/   the chart
  helm/values-local.yaml kind overrides (locally built images)
  helm/values-eks.yaml   EKS overrides (GHCR images, ALB, gp3 volumes)
  kind-config.yaml       kind cluster for CI
  traefik-values.yaml    Traefik settings shared by Terraform and CI
  deploy-local.ps1       build + load + install on the local cluster
infra/
  local/                 Terraform: kind cluster + Traefik
  eks/                   Terraform: VPC, EKS, EBS CSI, ALB controller, GitHub OIDC role
.github/workflows/ci-cd.yml
```

## Run it locally (free)

Needs Docker Desktop, plus `terraform`, `kind`, `kubectl` and `helm`
(`winget install Hashicorp.Terraform Kubernetes.kind Kubernetes.kubectl Helm.Helm`).

Stop the Compose stack first if it's running (`docker compose down`).

```powershell
cd infra\local
terraform init
terraform apply          # creates the "soulside" kind cluster + Traefik (~2 min)
cd ..\..
.\deploy\deploy-local.ps1   # builds images, installs the chart, runs the smoke test
```

Open http://localhost:8080. Useful commands:

```powershell
kubectl get pods -n soulside                 # everything Running and Ready?
kubectl logs -n soulside deploy/soulside-api # API logs
kubectl delete pod -n soulside soulside-mongo-0   # Mongo comes back with the same data
```

Tear down: `cd infra\local; terraform destroy`.

## Deploy to EKS (costs money)

The EKS stack (control plane, 2 × t3.medium nodes, NAT gateway, ALB) runs
roughly $6 a day at us-east-1 on-demand prices. Check the AWS pricing
calculator for your region, and destroy it when you're done.

Needs the AWS CLI, logged in to your account.

```powershell
cd infra\eks
terraform init
terraform apply          # ~15-20 min
terraform output         # note github_actions_role_arn
```

Then in the GitHub repo:

1. **Settings → Environments → New environment** `production`, and add the
   secret `AWS_DEPLOY_ROLE_ARN` = the `github_actions_role_arn` output.
2. **Settings → Secrets and variables → Actions → Variables**: add
   `EKS_CLUSTER_NAME` = `soulside` and `AWS_REGION` = `us-east-1`.
3. After the first merge pushes images, make the two packages
   (`soulside-notes-api`, `soulside-notes-web`) public under your GitHub
   profile → **Packages → Package settings → Change visibility**, so EKS can
   pull them. (Or keep them private and set `imagePullSecrets` in the chart.)

Every merge to `main` now deploys. The job summary prints the ALB URL.

To tear down, remove the app first so the ALB and EBS volumes are deleted
(otherwise they block `terraform destroy` or linger and keep costing):

```powershell
aws eks update-kubeconfig --name soulside --region us-east-1
helm uninstall soulside -n soulside
kubectl delete pvc --all -n soulside
cd infra\eks; terraform destroy
```

## The pipeline

`.github/workflows/ci-cd.yml`, on every PR and push to `main`:

1. **test**: server type-check, frontend build, Vitest unit tests
2. **helm-lint**: `helm lint --strict` with both values files
3. **build**: builds both images (pushed to GHCR only on `main`, tagged with the commit SHA and `latest`)
4. **kind-smoke-test**: creates a kind cluster in the runner, installs Traefik
   and the chart, then checks: `helm test`, the frontend, `/api/notes`, a real
   WebSocket upgrade (101) through the Ingress, and that notes survive a Mongo
   pod restart
5. **deploy** (`main` only, once `EKS_CLUSTER_NAME` is set): assumes the AWS
   role via OIDC (no stored AWS keys), `helm upgrade` with the new SHA, rolls
   back automatically if the pods don't become ready, then runs `helm test`

The deploy role can only manage the `soulside` namespace.

## Design notes

- **Why the API stays at one replica:** `server/realtime.ts` keeps WebSocket
  clients, the event buffer and its sequence numbers in memory. With two pods,
  a change saved through pod A would only be broadcast to clients connected to
  pod A. Scaling out needs a shared channel first, e.g. Redis pub/sub, which is
  already in the stack.
- **Why `/healthz` and `/readyz`:** the old healthcheck called `/api/notes`,
  which goes through the simulated latency and 5% failure middleware, so a
  healthy pod would randomly fail probes. Liveness deliberately ignores
  Mongo/Redis (restarting the API can't fix a database outage); readiness
  checks them, so traffic stops while they're down.
- **Why Traefik and not ingress-nginx:** the Kubernetes project retired
  ingress-nginx in March 2026; it no longer receives security fixes.
- **The Mongo password** is generated on first install and reused on every
  upgrade (Mongo only reads it when initialising an empty volume). The Secret
  is kept on `helm uninstall` for the same reason.
