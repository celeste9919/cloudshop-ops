# CloudShop Architecture

## Overview

CloudShop is a cloud-native e-commerce backend platform running on Kubernetes.

The current business scope includes:

- Product listing
- Product creation
- MySQL persistence
- Redis caching
- Health and readiness endpoints
- Prometheus metrics

## Infrastructure

| Component | Responsibility |
|---|---|
| edge-01 / edge-02 | HAProxy and Keepalived |
| 172.25.254.108 | High-availability virtual IP |
| k8s-master | Kubernetes control plane |
| k8s-node1 / k8s-node2 | Kubernetes workers |
| infra-01 | GitLab, Harbor, GitLab Runner and NFS |
| Ingress-NGINX | Kubernetes HTTP and HTTPS routing |

## Application Flow

```text
Client
  |
  v
Keepalived VIP 172.25.254.108
  |
  v
HAProxy
  |
  +--> GitLab
  +--> Harbor
  +--> Kubernetes Ingress
          |
          v
      CloudShop API
        |       |
        v       v
      MySQL   Redis
Kubernetes Namespaces
Namespace	Purpose
cloudshop-data	MySQL, Redis and logical backups
cloudshop-app	CloudShop API
cloudshop-ci	CI image test application
monitoring	Prometheus, Grafana, Alertmanager and Loki


Application Components
The API Deployment runs two replicas across the Kubernetes worker nodes.
The API uses:
MySQL service: mysql.cloudshop-data.svc.cluster.local
Redis service: redis.cloudshop-data.svc.cluster.local
Service port: 80
Container port: 8080
The API retries dependency initialization during startup so temporary MySQL, Redis or DNS interruptions do not immediately terminate the process.
Observability
Prometheus scrapes the API through a ServiceMonitor at:
/metrics
Grafana provides the CloudShop API dashboard with:
API availability
Request rate
5xx error rate
P95 latency
Resident memory
Prometheus alerts cover:
API unavailable
Metrics target missing
High 5xx rate
High P95 latency
Data Protection
MySQL logical backups are stored on the mysql-logical-backups PVC.
The backup CronJob:
Runs daily at 03:30
Uses mysqldump
Compresses backups with gzip
Creates SHA256 checksums
Retains backups for 14 days
Backup restore has been verified in an isolated temporary MySQL instance.
