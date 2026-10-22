


# 溜达喵 Neko Wander


<p align="center"><img src="assets/logo.png" alt="溜达喵 Logo" height="180"> <img src="assets/neko-wander.png" alt="溜达喵 Logo" height="180"></p>

<h3 align="center">A little wander, a little wonder</h3>

<h3 align="center">溜达溜达，瞅点儿新鲜</h3>



## 太长不看

溜达喵希望借助AI基础服务（大肥鱼牛逼），提供个性化的导航方案，可在对话中搜索地点、标记地图，规划和比较多种出行路线。

目前版本仅为测试demo，更多惊喜还在规划


<table>
  <tr>
    <td align="center"><img src="assets/neko.png" alt="溜达喵角色形象" height="280"></td>
    <td align="center">
      <video src="https://github.com/user-attachments/assets/f498ca64-5b1a-4f9f-82b3-eecf71df2711" controls height="280"></video>
    </td>
  </tr>
</table>


## 快速开始

### 1. 申请高德 Key

在[高德开放平台控制台](https://console.amap.com/)注册或登录，进入「应用管理」，创建一个应用，并在其中添加两种 Key：

| 高德服务平台 | 用途 | 环境变量 |
| --- | --- | --- |
| [Web 服务](https://lbs.amap.com/api/webservice/create-project-and-key) | 地点、地址与路线查询，由 DSH Host 调用 | `AMAP_WEB_KEY` |
| [Web 端（JS API）](https://lbs.amap.com/api/javascript-api-v2/prerequisites) | 在浏览器显示交互地图 | `AMAP_JS_KEY` |
| 创建 JS API Key 时得到的安全密钥 | JS API 鉴权 | `AMAP_JS_SECURITY_CODE` |


在启动 DSH 的同一个终端设置环境变量。PowerShell 示例：

```powershell
$env:AMAP_WEB_KEY = '你的 Web 服务 Key'
$env:AMAP_JS_KEY = '你的 Web 端 JS API Key'
$env:AMAP_JS_SECURITY_CODE = '对应的 JS API 安全密钥'
```

macOS / Linux 示例：

```sh
export AMAP_WEB_KEY='你的 Web 服务 Key'
export AMAP_JS_KEY='你的 Web 端 JS API Key'
export AMAP_JS_SECURITY_CODE='对应的 JS API 安全密钥'
```


### 2. 安装到 DSH Web profile

**npm 发布后**，可在已安装 DSH CLI 的环境中运行：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-neko-wander
dsh web
```

也可以在 DSH Web 侧边栏的「插件」页面安装同一个 npm 包名。插件的 `dsh.bundle` 会启用 `cordis.patch.yml`，从上述环境变量读取 Key。安装后若插件尚未生效，请重启 Web profile。


### 3. 在对话中使用

打开 Web 对话，右侧会出现「溜达喵地图」。首次打开地图时允许浏览器定位；也可以在对话里明确给出城市、起点或地址。例如：

> 附近有没有适合散步的公园？先在地图上给我几个候选点。

> 回家路上想绕去一个安静的地方，帮我比较绕行时间；我选好以后再规划骑行路线。

> 把长风街一带圈出约 500 米范围。那个文具店的具体位置再用大头针标出来。

地点搜索、地址查询和周边搜索会把候选点标在地图上；点击大头针或地址条目可以高亮地点。**点击地图标记只是查看地点，不会把它自动加入路线。** 需要路线时在对话中明确选择地点和出行方式。已规划路线不会因为继续搜索沿途店铺而消失；只有重新规划或要求清除路线才会改变它。

目前支持驾车、步行、自行车骑行、公交及地铁换乘、电动自行车路线；也可以比较直达与途经一个候选点的时间、距离差。地图上的导航入口会打开高德，由高德重新计算并让你确认行程。

## 源码本地试用

此仓库的源码按 DSH 工作区布局使用：把仓库放在 `deepseek-harness/packages/experimental/neko-wander`。需要与本插件匹配的 DSH 源码、Node.js 22.19.x 或 24+、pnpm，以及前面申请的三个高德配置值。当前仓库中的 `run-local.ps1` 仅提供 Windows PowerShell 启动方式。

在 **DSH 仓库根目录**执行：

```powershell
pnpm install
pnpm run build:artifacts

$env:AMAP_WEB_KEY = '你的 Web 服务 Key'
$env:AMAP_JS_KEY = '你的 Web 端 JS API Key'
$env:AMAP_JS_SECURITY_CODE = '对应的 JS API 安全密钥'

.\packages\experimental\neko-wander\run-local.ps1
```

脚本以源码 overlay 启动 DSH Web；默认把试用数据放在插件目录的 `.dsh-local`，不会把 Key 写入仓库。它要求插件确实位于上述 DSH 工作区路径。该方式用于本地验证；npm 安装方式使用预构建的 `lib/`，不依赖这个脚本。

开发者可查看[实现与接口备忘录](https://github.com/XiaoyuYoung/neko-wander/blob/main/docs/implementation-notes.md)，了解路线模式、定位状态和错误处理等细节。

## 当前提供的能力

| 能力 | 行为 |
| --- | --- |
| 动态地图与定位 | 右侧地图显示候选地点、路线和当前位置；浏览器授权后可以用当前位置搜索或作为路线起点。 |
| 地点与区域 | 搜索地点、查询地址或坐标；具体地点用大头针，模糊区域用可调整半径的圆圈。 |
| 路线与绕行 | 对比途经点与直达路线，按选定方式显示路线、时间和距离；公交路线可显示换乘和步行接驳信息。 |
| 继续探索 | 路线生成后仍可搜索沿途地点；新搜索只更新候选标记，不会自动改写路线。 |

插件工具使用 `neko_` 前缀，包括 `neko_search_places`、`neko_search_nearby`、`neko_geocode`、`neko_reverse_geocode`、`neko_show_place`、`neko_show_area`、`neko_compare_detour`、`neko_plan_route` 和清除工具。坐标采用高德 GCJ-02 的「经度,纬度」顺序。

## 已知限制

- **定位与状态**：精确定位需要浏览器授权，以及 HTTPS 或 `localhost` 等安全环境；IP 定位只是大致位置。地图和定位状态保存在当前 DSH 进程内，重启后清空。
- **高德服务**：地点和路线结果受高德账号权限、配额、地区及实时数据影响。公交暂不支持途经点、指定出发时间、备选方案切换、火车或出租车接驳；票价和班次应在高德确认。
- **导航跳转**：高德会重新规划，跳转后的路线可能与插件显示的折线不同。骑行入口主要面向手机；电动车需要在高德中手动切换相应模式。真实手机上的 App 唤起尚未完成验证。
- **部署范围**：目前主要供开发者本机试用。虽然地图与定位接口使用 DSH Connection 鉴权，JS API 安全密钥仍会进入浏览器；公开部署前需要接入高德安全代理并验证 HTTPS、网络监听和访问控制。
