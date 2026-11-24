# faas-demo

一个「地基常驻、业务模块可热更新」的 Express 平台 demo。

业务代码（controller / service）以 **TS 源码 → CJS bundle → vm 沙箱执行** 的方式加载，
路由表只挂一次，换版靠替换内部路由表，**不重启进程**。

- 开发态：保存代码 → 自动重建 → 换版
- 生产态：从 OSS 拉取预构建产物，轮询 / webhook 触发换版
- 发布：一条命令上传差异产物 + manifest，支持版本归档与回滚

## 特性

- **注解式开发**：`@Controller` / `@Get` / `@Post` / `@Service` / `@Resource` / `@Param` / `@Body`
- **进程级 IOC**：`@Service` 是进程内单例，`@Resource` 惰性注入，替换 service 后已有 controller 自动拿到新实例
- **manifest 驱动**：每个 bundle 带内容哈希与依赖指纹，按 `version` 增量下载、sha256 校验
- **热更安全**：构建产物未变化就跳过换版；删除源码自动移除路由；任何模块异常都不会带走进程
- **可回滚**：本地保留上一代（`manifest.prev.json`），远端归档每个版本（`manifests/<id>.json`）
- **部署简单**：`dist/server/index.js` 是自包含单文件（含 express 与 ali-oss），部署只需要 `dist/`

## 目录结构

```
packages/
  runtime/   @faas/runtime     模块契约：装饰器、元数据、容器、controllerRouter
  core/      @faas/core        沙箱执行、registry、路由表、app 工厂、manifest 存储、Builder 端口
  compiler/  @faas/compiler    rollup 构建 + manifest 生成（只在构建期使用）
  dev/       @faas/dev         fs.watch 热更
  remote/    @faas/remote      OSS 源、同步、上传、清理、版本归档与回滚
apps/server/                   服务入口（index.ts）+ 热区（src/modules）
scripts/                       build-server.mjs、upload-modules.ts
```

依赖方向是单向的：

```
@faas/runtime  ← 热区模块
     ↑
@faas/compiler ──(仅类型)──→ @faas/core ← apps/server
                                ↑
                            @faas/dev
```

`@faas/core` 的生产依赖只有 `express` + `@faas/runtime`——**rollup 不在运行时依赖树里**。

## 快速开始

要求：Node >= 20、pnpm。

```bash
pnpm install
pnpm dev                                    # 构建热区 + 启动 + 热更
curl http://localhost:3000/health           # {"status":"ok"}
curl http://localhost:3000/api/users/list   # [{"id":"u_1001",...}]
```

## 写一个模块

**1. Controller**（必须放在 `**/controller/` 下，默认导出 router）

```ts
import { Body, Controller, Get, Param, Post, Resource, controllerRouter } from "@faas/runtime";
import type { CreateUserInput, User } from "../entity/User";
import type { UserService } from "../service/UserService";

@Controller("/users")
export class UserController {
  @Resource
  private userService!: UserService;

  @Get("/list")
  list(): User[] {
    return this.userService.list();
  }

  @Get("/detail/:id")
  detail(@Param("id") id: string): User | null {
    return this.userService.find(id) ?? null;
  }

  @Post("/create")
  create(@Body() input: CreateUserInput): User {
    return this.userService.create(input);
  }
}

export default controllerRouter(UserController);
```

**2. Service**（必须放在 `**/service/impl/` 下）

```ts
import { Service } from "@faas/runtime";

@Service()
export class UserServiceImpl implements UserService {
  list(): User[] { /* ... */ }
}
```

约定：

| 约定 | 说明 |
| --- | --- |
| 入口文件 | `**/controller/*.ts`，一个文件恰好一个 controller，并 `export default controllerRouter(X)` |
| Service 文件 | `**/service/impl/*.ts`，`@Service()` 在模块求值时注册 |
| bean 名 | 去掉 `Impl` 前缀后首字母小写：`UserServiceImpl` → `userService`；也可 `@Service("customName")` 指定 |
| 注入 | `@Resource private userService!` 按属性名；`@Resource("name")` 显式指定 |
| 可见依赖 | 模块只应 import `@faas/runtime` 和自己的相对文件；其它裸模块会保持 external，运行期由宿主 `require` 解析（部署时未必存在） |
| 返回值 | handler 的返回值自动序列化（对象/数组 → JSON，字符串 → 文本）；自己写 `res` 也可以 |

## 运行模式

| 模式 | 入口 | 产物来源 | 换版方式 |
| --- | --- | --- | --- |
| 开发 | `apps/server/src/dev.ts`（vite-node 跑源码） | 本地源码实时编译 | `fs.watch`，200ms 防抖 |
| 生产·远端 | `dist/server/index.js`（`MODULES_SOURCE=oss`） | OSS 拉取 | 轮询 `/` webhook |
| 生产·本地 | `dist/server/index.js`（`MODULES_SOURCE=dir`） | 本地已有产物 | 需要重新发布 + 重启 |

## 构建与部署

```bash
pnpm build:modules   # 扫描热区 → dist/modules/{controller,service}/*.js + manifest.json
pnpm build:server    # esbuild → dist/server/index.js（自包含，含 express 与 ali-oss）
pnpm build           # 两者
```

产物：

```
dist/
├─ server/
│  ├─ index.js        # 生产入口（2.5 MB，已内联 express / ali-oss）
│  └─ package.json    # {"type":"module"}，让 dist/server 能脱离仓库根单独运行
└─ modules/           # 构建产物
   ├─ manifest.json
   ├─ controller/*.js
   └─ service/*.js

# 运行时缓存目录（MODULES_DIST_DIR，oss 模式会额外多两个文件）
<MODULES_DIST_DIR>/
├─ manifest.json
├─ manifest.prev.json  # 上一代，用于 /__admin/rollback
├─ .etag               # 远端 manifest 的 ETag
├─ controller/*.js
└─ service/*.js
```

部署与启动：

```bash
# 方式一：产物随包发布（离线）
pnpm build
MODULES_SOURCE=dir PORT=3000 node dist/server/index.js

# 方式二：启动时从 OSS 拉取（推荐）
MODULES_SOURCE=oss PROJECT_NAME=faas-demo PORT=3000 node dist/server/index.js
```

关键环境变量（完整列表见 [.env.example](.env.example)）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MODULES_SOURCE` | `oss` | `oss` 从远端拉取；`dir` 直接用本地产物 |
| `MODULES_DIR` | `<ROOT>/apps/server/src/modules` | 热区目录 / 远端缓存目录 |
| `MODULES_DIST_DIR` | `<ROOT>/dist/modules` | 产物目录（manifest + bundle） |
| `PROJECT_NAME` | `faas-demo` | OSS key 前缀：`<PROJECT_NAME>/modules` |
| `REMOTE_POLL_MS` | `30000` | 轮询间隔；`0` 表示只靠 webhook |
| `KEEP_GENERATIONS` | `2` | 本地缓存保留几代（=能否回滚） |
| `PRUNE_ON_SYNC` | `true` | 同步后是否清理过期产物 |
| `ADMIN_TOKEN` | 空 | 设置后 `/__admin/*` 需要 `Authorization: Bearer <token>` |
| `PORT` / `BASE_PATH` | `3000` / `/api` | 端口与全局路由前缀 |

## 发布到 OSS

```bash
cp .env.example .env         # 填 OSS 凭证与 PROJECT_NAME
pnpm deploy:modules          # = build:modules + upload:modules
```

上传行为：

1. 以 `manifest.json` 为准校验本地文件齐全；
2. 内容 MD5 与远端 ETag 一致的跳过；
3. 先传 bundle，再归档 `manifests/<version>.json`，**最后传 `manifest.json`**；
4. 可选 `--prune` 清理保留窗口之外的旧产物（默认带 10 分钟宽限期）。

```bash
pnpm upload:modules                          # 只上传
pnpm upload:modules --dry-run                # 看计划
pnpm upload:modules --prune                  # 上传 + 清理
pnpm upload:modules --prune --keep=2 --grace-ms=600000
pnpm upload:modules --versions               # 列出历史版本
pnpm upload:modules --rollback=<version>     # 把某个历史版本重新发布（跨实例回滚）
```

OSS 上的布局：

```
<PROJECT_NAME>/modules/
├─ manifest.json
├─ manifests/<sha256-16>.json
├─ controller/<Name>.<hash8>.js
└─ service/<Name>.<hash8>.js
```

## 运行时接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查（不受 `BASE_PATH` 影响） |
| `GET` | `/__admin/modules` | 当前加载的产物版本、路由、bean 依赖 |
| `POST` | `/__admin/sync` | 触发一次同步；有变化则换版（webhook 入口） |
| `POST` | `/__admin/rollback` | 回滚到本地保留的上一代（仅 `oss` 模式） |

## 热更新是怎么工作的

```
源码/OSS ──→ manifest（version + deps）
                 │
      ┌──────────┴───────────┐
   dev: fs.watch          prod: 轮询 / webhook
      │                      │
      └──── 重建或下载 ────────┘
                 │
        version 变了才换版
                 │
     vm 沙箱求值 → 装饰器写元数据 → 容器实例化 → 新 Router
                 │
        composed 路由表整体替换（一次赋值）
```

不变量：

1. **Express 路由表只挂一次**，换版只替换内部 `composed`；
2. **`@faas/runtime` 只有一个实例**（构建期 external，运行期映射回宿主）；
3. **元数据按类对象存**，每次求值都是新类，天然区分代际；
4. **产物 hash 不变就不换版**（重建便宜，swap 谨慎）；
5. **manifest 永远最后写**，任何时刻它只指向已存在的文件。

## 保留策略与回滚

| 位置 | 保留 | 清理时机 | 回滚方式 |
| --- | --- | --- | --- |
| 构建机 `dist/modules` | 仅当前 manifest | `buildAll` 时 | — |
| 服务器缓存（`oss` 模式） | current + `KEEP_GENERATIONS-1` | 每次 sync 成功后 | `POST /__admin/rollback` |
| OSS | 最近 N 代 manifest 引用的对象 | `--prune`（带宽限期） | `--rollback=<version>` |

回滚语义：本地回滚不改 `.etag`，所以实例会停在旧版本，直到远端发布新版本；远端回滚是重新发布旧 manifest，所有实例在下一次轮询后生效。

## 已知限制

1. **vm 不是安全边界**：模块代码可以逃逸到宿主进程。只用于执行自己发布的代码；若将来要跑第三方代码，应换 `isolated-vm` 或 worker 隔离。
2. **manifest 未签名**：能写 OSS 就等于能执行代码，建议 AK 只读并限定前缀，后续可加 HMAC 签名。
3. **bundle 体积**：`dist/server/index.js` 约 2.5 MB（express + ali-oss 内联）。
4. **`proxy-agent` 是 external**：ali-oss 的 `urllib` 只有在配置 HTTP 代理时才会 `require` 它，需要代理时请自行安装。
5. **service 热更会丢内存状态**：重载 = 重新 `new`，缓存/计数器会重置。
6. **OSS 旧产物只在 `--prune` 时清理**，默认只加不删。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `controller 产物 X 没有注册 @Controller` | 产物过期或源码为空：重新 `pnpm build:modules` |
| `找不到模块产物：.../manifest.json` | `MODULES_SOURCE=dir` 时没有构建产物，先 `pnpm build` |
| `bean 名冲突` | 两个 `@Service` 解析出同一个 bean 名：用 `@Service("name")` 区分 |
| `Could not resolve ...` | 模块里 import 了 `@faas/runtime` 之外的包：热区只允许 runtime + 自己的文件 |
| 修改代码没生效 | dev 模式看日志有没有 `[registry] 变更 ...`；生产模式检查轮询间隔 / webhook |

## 脚本一览

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 构建热区 + 启动 + 文件监听热更 |
| `pnpm build` | `build:modules` + `build:server` |
| `pnpm build:modules` | 只构建模块产物 |
| `pnpm build:server` | 只打包服务端入口 |
| `pnpm start` | 运行 `dist/server/index.js` |
| `pnpm upload:modules` | 上传产物到 OSS |
| `pnpm deploy:modules` | 构建 + 上传 |
| `pnpm typecheck` | 5 个包全量类型检查 |
