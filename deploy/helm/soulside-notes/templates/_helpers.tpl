{{/* Base name: the release name, so `helm install soulside ...` gives soulside-api, soulside-mongo, ... */}}
{{- define "soulside.fullname" -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "soulside.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Selector labels for one component. Usage: include "soulside.selectorLabels" (dict "ctx" . "component" "api") */}}
{{- define "soulside.selectorLabels" -}}
app.kubernetes.io/name: {{ .ctx.Chart.Name }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Image reference. Usage: include "soulside.image" (dict "ctx" . "image" .Values.api.image) */}}
{{- define "soulside.image" -}}
{{- printf "%s:%s" .image.repository (default .ctx.Chart.AppVersion .image.tag) -}}
{{- end -}}

{{- define "soulside.mongoSecretName" -}}
{{- if .Values.mongo.auth.existingSecret -}}
{{- .Values.mongo.auth.existingSecret -}}
{{- else -}}
{{- printf "%s-mongo" (include "soulside.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* Pod-level hardening shared by every workload. */}}
{{- define "soulside.podSecurity" -}}
seccompProfile:
  type: {{ .Values.podSecurity.seccompProfile }}
{{- end -}}
