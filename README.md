# 溜达喵地图插件原型

这是一个可选的 DSH Web 插件。地图业务代码在 `src/map-service.ts`，Harness 工具与页面接入在 `src/index.ts` 和 `src/client/index.ts`。源码作为独立 Git 仓库管理，使用时放在 DSH 工作区的 `packages/experimental/neko-wander` 中，共用 DSH 的依赖和构建配置。

## 配置与启动

申请高德 **Web 服务 API Key**、

**Web 平台 JS API Key** 及其安全密钥，

分别设置 `AMAP_WEB_KEY`、`AMAP_JS_KEY`、`AMAP_JS_SECURITY_CODE`。不要把真实密钥写入仓库。先在仓库根目录构建客户端 bundle，再用本地脚本启动（脚本会生成指向当前源码的绝对路径 overlay）：

```powershell
$env:AMAP_WEB_KEY = 'YOUR_AMAP_WEB_KEY'
$env:AMAP_JS_KEY = 'YOUR_AMAP_JS_KEY'
$env:AMAP_JS_SECURITY_CODE = 'YOUR_AMAP_JS_SECURITY_CODE'
pnpm run build:artifacts
.\packages\experimental\neko-wander\run-local.ps1
```

`cordis.patch.yml` 是将该包安装到 DSH profile 后使用的组合包配置层；本地源码运行使用 `run-local.ps1`。本地脚本默认将 `DSH_HOME` 放在插件目录的 `.dsh-local`，也可预先指定其他位置。

进入 Web 对话后，右侧 Sidebar 的引导页会出现“溜达喵地图”。第一次调用地图工具产生候选点时，地图标签会自动打开。地图可缩放、拖动；搜索结果显示标记，明确调用路线工具后显示路线折线。

可用工具：`neko_search_places`、`neko_search_nearby`、`neko_geocode`、`neko_reverse_geocode`、`neko_compare_detour`、`neko_drive_route`。坐标统一采用高德 GCJ-02 的“经度,纬度”格式。绕行比较分别向高德请求直达和途经候选点的驾车路线，计算时间与距离差，不会生成最终路线。路线工具会把折线同步到当前对话的地图标签。

地图状态按 DSH Session 保存在运行进程内，浏览器每 2.5 秒读取一次；重启服务后会清空。当前只面向本机 Web 原型，状态端点拒绝非本机请求。JS API 安全密钥按高德开发模式注入浏览器；公开部署前应改为高德建议的服务端安全代理。高德 Web 服务 Key 只留在 Host 端。

## Model Experience

### Map tool definitions

#### What the model sees

模型可调用 `neko_search_places`、`neko_search_nearby`、`neko_geocode`、`neko_reverse_geocode`、`neko_compare_detour` 和 `neko_drive_route`。搜索工具说明要求先展示候选点；路线工具说明要求用户选定地点或明确要求路线后再调用。

#### Token effect

工具定义带来固定的 schema token 开销。

#### KV Cache effect

定义不变时工具 schema 可保持缓存前缀稳定；插件启用或关闭会改变工具列表。

### Tool results

#### What the model sees

地点与坐标查询返回候选资料；绕行工具返回与直达路线的差值；路线工具只返回时长和距离。完整路线折线仅供右侧地图绘制。工具结果进入对话记录，地图状态本身不是持久 Session 数据。

#### Token effect

结果随候选地点数量增长，路线折线不会加入模型上下文。

#### KV Cache effect

新的工具结果附加在已有请求前缀之后。

## Known Limitations and Deferred Work

- 这是地图模块原型，没有推荐排序、社交媒体资料或用户选择状态。
- 高德 POI 和驾车时间取决于账户配额、地区及实时服务；无 Key 时无法进行真实 API 验证。
- 浏览器状态接口和 JS 密钥配置只适合本机 Web 验证；生产发布需接入 DSH 的认证 Remote 并使用高德安全代理。
