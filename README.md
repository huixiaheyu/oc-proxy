# 🔄 OC-Proxy

**免费 AI 模型的统一中转站 —— 一个服务聚合所有上游，OpenAI / Anthropic 双协议兼容。**

[![Node.js 18+](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/huixiaheyu/oc-proxy/pkgs/container/oc-proxy)
[![Release](https://img.shields.io/github/v/release/huixiaheyu/oc-proxy?style=for-the-badge)](https://github.com/huixiaheyu/oc-proxy/releases)

[快速开始](#快速开始) · [为什么需要它](#为什么需要它) · [功能](#功能) · [架构](#架构) · [配置参考](#配置参考) · [对比](#与现有方案对比)

---

## 为什么需要它

**Before：** 免费 AI 模型分散在不同平台，每个都要单独配置 API Key 和 Base URL，切换模型要改一堆配置。

**After：** 一个服务聚合所有上游，统一接口、统一 Key、网页管理，客户端只填一个地址。

| 痛点 | OC-Proxy 的解法 |
|------|----------------|
| 免费模型分散、需要逐个注册 | 内置 OpenCode Free，零配置直接用 |
| 不同上游接口格式不统一 | 统一 OpenAI 兼容 + Anthropic 兼容 |
| 切换模型要改客户端配置 | 前缀命名空间，`oc/model` 一个名字搞定 |
| 不知道哪个模型能用 | 内置 TTFT 测试，一键批量检测连通性 |
| 上游配置分散 | 网页可视化管理，实时增删改查 |

---

## 功能

- **双协议兼容** —— `POST /v1/chat/completions`（OpenAI）+ `POST /v1/messages`（Anthropic），Claude Code / Cursor / 任意 OpenAI SDK 直接接入
- **多上游聚合** —— 内置 OpenCode Free + 无限自定义上游（中转站 / OpenRouter / 国内 API 等）
- **前缀命名空间** —— 每个上游一个前缀，`oc/mimo-v2.5-free`、`mysrv/gpt-4o`，避免重名
- **实时模型列表** —— `GET /v1/models` 自动拉取所有上游最新模型，10 分钟缓存
- **TTFT 测速** —— 单模型 / 按组 / 全部测试首 token 延迟，结果行内实时显示
- **网页管理** —— 三页签：接入信息（一键复制）、可用模型（分组折叠）、上游管理（CRUD）
- **SSE 流式透传** —— 完整支持流式响应，背压控制，逐 token 转发
- **Anthropic 协议转换** —— 自动处理 system、content blocks、tool_use / tool_result 双向转换，支持流式
- **API Key 动态管理** —— 网页即时修改，持久化到磁盘，旧 Key 立即失效

---

## 快速开始

### Docker（推荐）

```bash
# 1. 启动
docker run -d \
  --name oc-proxy \
  -p 20128:20128 \
  -e API_KEY=sk_oc_proxy \
  -v ./data:/app/data \
  --restart unless-stopped \
  ghcr.io/huixiaheyu/oc-proxy:latest

# 2. 打开网页
# http://localhost:20128
```

### Docker Compose

```yaml
services:
  oc-proxy:
    image: ghcr.io/huixiaheyu/oc-proxy:latest
    container_name: oc-proxy
    restart: unless-stopped
    ports:
      - "20128:20128"
    environment:
      - API_KEY=sk_oc_proxy
    volumes:
      - ./data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

```bash
docker compose up -d
```

### 从源码运行

```bash
git clone https://github.com/huixiaheyu/oc-proxy.git && cd oc-proxy
npm install
npm start
```

### 客户端接入

打开 `http://<服务器IP>:20128`，在「接入信息」页复制 **Base URL** 和 **API Key**：

```
Base URL:  http://<服务器IP>:20128/v1
API Key:   sk_你的key
Model:     oc/mimo-v2.5-free
```

### 添加自定义上游

网页 → **上游管理** → 填写名称、前缀、Base URL、API Key → 保存。

模型自动带前缀出现，如 `mysrv/gpt-4o`，直接调用即可。

---

## 架构

```
┌─────────────┐     ┌──────────────────────────────────────────────────┐
│   Client    │────▶│                  OC-Proxy                         │
│  (SDK/CLI)  │     │  ┌──────────┐  ┌────────┐  ┌─────────────────┐  │
└─────────────┘     │  │ Auth +   │  │ Router │  │ Protocol        │  │
                    │  │ API Key  │─▶│ Prefix │─▶│ Converter       │  │
                    │  └──────────┘  └───┬────┘  └────────┬────────┘  │
                    └────────────────────┼────────────────┼───────────┘
                                         │                │
                            ┌────────────▼──┐   ┌────────▼──────────┐
                            │   Built-in    │   │   Custom          │
                            │   OpenCode    │   │   Upstreams       │
                            │   Free (oc/)  │   │   (mysrv/...)     │
                            └───────────────┘   └───────────────────┘
```

**请求流程：** Client → 鉴权 → 解析 `前缀/模型名` → 匹配上游 → 协议转换（Anthropic↔OpenAI） → 转发 → SSE 流式透传

---

## 配置参考

<details>
<summary><b>环境变量</b>（点击展开）</summary>

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `20128` | 监听端口 |
| `HOSTNAME` | `0.0.0.0` | 绑定地址 |
| `API_KEY` | `sk_9router` | 初始 API Key（部署后可在网页修改） |
| `ALLOW_PUBLIC_API` | `false` | 设为 `true` 跳过鉴权（仅内网调试） |
| `DATA_DIR` | `./data` | 上游配置和设置的存储目录 |
| `MODEL_CACHE_TTL_MS` | `600000` | 模型列表缓存时长（默认 10 分钟） |
| `UPSTREAM_KEEP_ALIVE_MS` | `60000` | 上游空闲连接保活时长（默认 60s） |

</details>

<details>
<summary><b>API 接口</b>（点击展开）</summary>

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 服务状态检查 |
| `POST` | `/v1/chat/completions` | OpenAI 兼容对话（支持流式） |
| `POST` | `/v1/messages` | Anthropic Messages API（自动协议转换） |
| `GET` | `/v1/models` | 所有可用模型（`?prefix=oc` 筛选指定上游） |
| `POST` | `/v1/models/test` | TTFT 测速：`{ model: "oc/xxx", prompt?: "ping" }` |
| `GET` | `/api/upstreams` | 列出自定义上游 |
| `POST` | `/api/upstreams` | 新增上游 |
| `PUT` | `/api/upstreams/:id` | 更新上游 |
| `DELETE` | `/api/upstreams/:id` | 删除上游 |
| `GET` | `/api/meta` | 前端元数据（apiKey / baseUrl） |
| `POST` | `/api/settings/api-key` | 修改 API Key |

</details>

---

## 与现有方案对比

| 特性 | **OC-Proxy** | One API | New API |
|------|:---:|:---:|:---:|
| 免费模型内置 | 零配置 | 需手动添加 | 需手动添加 |
| Anthropic 协议 | 原生支持 + 流式转换 | 不支持 | 不支持 |
| TTFT 测速 | 单个 / 按组 / 全部 | 不支持 | 不支持 |
| 部署依赖 | 2 个（express + undici） | Go 编译 | Go 编译 |
| 前缀命名空间 | 支持 | 支持 | 支持 |
| 多上游聚合 | 支持 | 支持 | 支持 |
| Web 管理 | 支持 | 支持 | 支持 |

---

## 目录结构

```
oc-proxy/
├── server.js              # Express 入口：鉴权 + 路由 + 上游管理 API
├── lib/
│   ├── upstreams.js       # 上游管理（内置 opencode + 自定义），JSON 持久化
│   ├── settings.js        # 运行时设置管理（API Key 持久化）
│   ├── models.js          # 多上游模型拉取 + 缓存 + 前缀合并
│   ├── proxy.js           # /v1/chat/completions 按前缀路由 + TTFT 测试
│   └── anthropic.js       # /v1/messages Anthropic ↔ OpenAI 双向协议转换
├── public/
│   └── index.html         # 前端：三页签（接入信息 / 可用模型 / 上游管理）
├── Dockerfile
├── docker-compose.yml
├── .github/workflows/
│   └── release.yml        # 推送 tag 自动构建 Docker + 发布 Release
└── package.json           # express 5 + undici，零其他依赖
```

---

## 说明

- **内置 OpenCode** 前缀固定为 `oc`，仅展示免费模型（id 以 `-free` 结尾或命中白名单如 `big-pickle`）。
- 自定义上游模型**保留原名**，带前缀调用（如 `mysrv/gpt-4o`），无免费过滤。
- 服务仅做**直通转发**，不记录请求内容，不落盘聊天数据（仅持久化上游配置与运行时设置）。
- 网页修改 API Key 后旧 Key 立即失效，新 Key 持久化于 `data/settings.json`。
- 上游连接使用 undici Agent 连接池，支持可配置的 keep-alive 保活。

---

## License

[MIT](LICENSE)
