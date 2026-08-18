# CloudShop Ops

CloudShop Ops 是一个面向 Kubernetes 的电商商品目录与库存管理 MVP，包含 Node.js API、MySQL、Redis、商品管理界面、CI/CD、Prometheus/Grafana 监控、Loki 日志和 MySQL 逻辑备份。

当前项目定位为：**可部署、可观测的 CloudShop 商品目录与库存管理平台**。

## 已实现能力

- 商品列表、详情、创建和局部更新
- 商品分类、描述、图片 URL 和库存数量
- 商品分类筛选和库存增减
- MySQL 持久化与 Redis 商品目录缓存
- `/healthz`、`/readyz` 和 `/metrics` 健康及监控接口
- MySQL、Redis、API 的 Kubernetes 部署清单
- GitLab CI 基础设施部署和 API 发布流程
- Prometheus ServiceMonitor、Grafana Dashboard 和告警规则
- Loki 日志采集与 Grafana datasource
- 每日 MySQL 逻辑备份、gzip 压缩、SHA256 校验和 14 天保留
- 商品管理 Web 界面，由 API 容器直接托管
- 用户注册、登录、退出和当前用户查询
- Redis 会话、购物车和事务性订单创建

## 架构

```text
Client -> Ingress-NGINX -> CloudShop API (2 replicas)
                              |              |
                              v              v
                            MySQL           Redis
                              |
                              v
                        Logical Backup PVC

Prometheus --> API /metrics
Grafana    --> Prometheus and Loki
Loki/Alloy --> Container logs
```

核心命名空间：

| 命名空间 | 内容 |
| --- | --- |
| `cloudshop-app` | CloudShop API、Service、Ingress、ServiceMonitor |
| `cloudshop-data` | MySQL、Redis、备份 PVC 和 CronJob |
| `monitoring` | Prometheus、Grafana、Alertmanager、Loki、Alloy |

## 目录结构

```text
apps/cloudshop-api/       API、商品管理界面和测试
kubernetes/apps/           API、命名空间和应用入口清单
kubernetes/middleware/     MySQL、Redis、备份和数据命名空间清单
monitoring/                Prometheus、Grafana、Loki 和告警配置
charts/                    本地 Helm chart 源码
docs/                      架构与部署文档
cicd/                      CI 测试镜像
```

## 本地 API 开发

API 需要 Node.js 22、MySQL 和 Redis。依赖服务通过环境变量配置：

```bash
cd apps/cloudshop-api
npm ci
npm test
node server.js
```

必要环境变量示例：

```text
PORT=8080
MYSQL_HOST=mysql.cloudshop-data.svc.cluster.local
MYSQL_PORT=3306
MYSQL_DATABASE=cloudshop
MYSQL_USER=cloudshop
MYSQL_PASSWORD=<runtime-secret>
REDIS_HOST=redis.cloudshop-data.svc.cluster.local
REDIS_PORT=6379
REDIS_PASSWORD=<runtime-secret>
```

实际密码不应写入 `.env`、YAML、Git、聊天记录或 CI 输出。

## 商品 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/products` | 获取商品列表，可使用 `?category=Accessories` 筛选 |
| `GET` | `/api/products/:id` | 获取单个商品 |
| `POST` | `/api/products` | 创建商品 |
| `PATCH` | `/api/products/:id` | 更新商品字段 |
| `POST` | `/api/products/:id/stock` | 使用 `{ "quantity": 1 }` 增减库存 |
| `GET` | `/api/categories` | 获取分类列表 |
| `POST` | `/api/auth/register` | 注册用户 |
| `POST` | `/api/auth/login` | 登录并建立 HttpOnly 会话 |
| `POST` | `/api/auth/logout` | 注销会话 |
| `GET` | `/api/auth/me` | 获取当前登录用户 |
| `GET` | `/api/cart` | 获取当前用户购物车 |
| `PUT` | `/api/cart/items/:productId` | 设置购物车商品数量 |
| `POST` | `/api/orders` | 将购物车转换为待支付订单并扣减库存 |
| `GET` | `/api/orders` | 获取当前用户订单 |
| `GET` | `/api/orders/:id` | 获取当前用户订单详情 |
| `POST` | `/api/orders/:id/cancel` | 取消待支付订单并恢复库存 |
| `GET` | `/api/admin/orders` | 管理员查看全部订单 |
| `GET` | `/healthz` | 进程健康检查 |
| `GET` | `/readyz` | MySQL 和 Redis 就绪检查 |
| `GET` | `/metrics` | Prometheus 指标 |

创建商品示例：

```bash
curl -X POST http://api.cloudshop.local/api/products \
  -H 'Content-Type: application/json' \
  -d '{"name":"CloudShop Keyboard","price":299,"category":"Accessories","stock":25}'
```

## Kubernetes 部署

CI Runner 需要能够访问 Kubernetes API、Harbor 和 GitLab。部署前在 GitLab 项目的 CI/CD Variables 中配置以下 masked/protected 变量：

```text
CLOUDSHOP_MYSQL_ROOT_PASSWORD
CLOUDSHOP_MYSQL_PASSWORD
CLOUDSHOP_REDIS_PASSWORD
CLOUDSHOP_ADMIN_EMAIL
CLOUDSHOP_ADMIN_PASSWORD
HARBOR_USER
HARBOR_PASSWORD
```

基础设施 Job 会创建命名空间、运行期 Secret、Harbor image pull Secret、MySQL、Redis、PVC 和逻辑备份 CronJob，并等待数据层就绪。配置管理员变量后，API 首次启动会自动创建管理员账户。API Job 随后应用 API、Ingress、ServiceMonitor 并滚动更新当前构建镜像。

本地检查清单：

```bash
export KUBECONFIG=/data/gitlab-runner/kubeconfig/ci-kubeconfig
kubectl apply --dry-run=server -f kubernetes/apps/namespace.yaml
kubectl apply --dry-run=server -f kubernetes/middleware/mysql-statefulset.yaml
kubectl apply --dry-run=server -f kubernetes/middleware/redis.yaml
kubectl apply --dry-run=server -f kubernetes/apps/cloudshop-api.yaml
```

## 监控与备份

Grafana 地址为 `grafana.cloudshop.local`，默认由 ingress-nginx NodePort `30080` 提供 HTTP 入口。API Dashboard 覆盖可用性、请求率、5xx、P95 延迟和进程内存；PrometheusRule 覆盖 API 不可用、目标丢失、5xx 过高和 P95 延迟过高。

MySQL 备份 CronJob 每天 `03:30` 运行，使用 `mysqldump` 生成 gzip 文件和 SHA256 校验文件，并删除超过 14 天的备份。

订单当前状态为 `pending_payment`，库存扣减和订单明细写入在同一数据库事务中完成。支付服务尚未接入，后续可以通过订单状态和支付适配器接入真实支付渠道。

## 验证

```bash
cd apps/cloudshop-api
npm test
node --check server.js
node --check public/app.js
npm audit --omit=dev --audit-level=high
```

发布前还应确认 MySQL、Redis PVC 为 `Bound`，API Pod readiness 为 `True`，Grafana Service 有就绪 Endpoint，最近一次备份 Job 为 `Complete`。

## 当前边界

当前版本已具备商品目录、用户认证、购物车和基础订单流程，尚未实现真实支付、退款、库存预占、对象存储图片上传和完整端到端测试。AI 告警分析与自动修复也不属于当前版本能力范围。

详细架构说明见 [`docs/architecture.md`](docs/architecture.md)。
