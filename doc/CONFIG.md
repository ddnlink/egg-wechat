## 配置文件
建议参考EggJS官网的[多环境配置](https://eggjs.org/zh-cn/basics/config.html#%E5%A4%9A%E7%8E%AF%E5%A2%83%E9%85%8D%E7%BD%AE)，本插件需要的配置项如下：

```js
// {app_root}/config/config.default.js
exports.wechat = {
  appId: '', // 公众平台应用编号
  appSecret: '', // 公众平台应用密钥
  mchId: '', // 商户平台商家编号
  apiKey: '', // 商户支付密钥
  notifyUrl: '', // 支付结果回调地址
  // 开放平台第三方平台配置
  componentAppId: '', // 第三方平台 AppID
  componentAppSecret: '', // 第三方平台 AppSecret
  componentToken: '', // 第三方平台消息校验 Token
  componentEncodingAESKey: '', // 第三方平台消息加解密 Key

  // ===== 可选：动态注入/覆盖配置（覆盖所有模块） =====
  // init 支持同步/异步：在应用启动前执行，返回对象会合并进 wechat 配置。
  // 适合：配置来自数据库/远程配置中心。
  init: async (app) => {
    // const ctx = app.createAnonymousContext();
    // const v = await ctx.service.xxx.get('some.key');
    // return { componentAppId: v };
    return {};
  },
  // 或者使用静态 override（无需异步）
  // override: { componentAppId: 'wx...', componentAppSecret: '...' },

  // ===== 推荐：Egg 风格 provider（运行时动态读取 + 插件侧缓存/周期刷新） =====
  // 插件会在启动时拉取一次，并按 unifiedConfigRefreshIntervalMs 周期刷新。
  // 返回对象会合并进 app.config.wechat（只合并非空字段）。
  // 适合：宿主希望完全掌控配置来源（数据库/配置中心/多租户等），且不想让插件耦合具体 key。
  getConfig: async (ctx) => {
    // return { componentAppId: 'wx...', componentAppSecret: '...' };
    return {};
  },

  // ===== 可选：运行时从统一配置读取（无需把密钥写进 config.wechat） =====
  // 条件：宿主项目提供 ctx.service.config.unifiedConfig.get(key)
  // 读取键映射（以 ddn-hub 为准）：
  // - wechat_platform.app_id                -> wechat.appId
  // - wechat_platform.app_secret            -> wechat.appSecret
  // - wechat_platform.component.app_id      -> wechat.componentAppId
  // - wechat_platform.component.app_secret  -> wechat.componentAppSecret
  // - wechat_platform.component.token       -> wechat.componentToken
  // - wechat_platform.component.encoding_aes_key -> wechat.componentEncodingAESKey
  // - wechat_platform.public_base_url       -> wechat.publicBaseUrl
  useUnifiedConfig: true,
  unifiedConfigRefreshIntervalMs: 30000,

  // ===== 可选：第三方平台 HTTP 入口能力（宿主侧映射路由） =====
  // 插件新增：ctx.service.wechat.platformHttp
  // 用途：承载微信开放平台第三方平台的 notify/callback/auth_url/auth_callback/mock_authorize
  // 推荐做法：宿主项目仅保留“薄 controller（用于 swagger/openapi）+ 显式 router 映射”，
  // 具体 HTTP 解析/验签/解密/回包逻辑由插件统一维护。
  //
  // 注意：auth_callback 需要宿主提供业务落库逻辑（例如 ddn-hub 的 ctx.service.third.wechatPlatform.handleAuthCallback）。

  // ===== 可选：多租户参数名（避免写死 daoId） =====
  // 适用：宿主项目不是用 daoId 作为租户参数名（例如 tenantId/orgId/spaceId）。
  // 说明：
  // - tenantIdParamName：生成 auth_callback redirect_uri 时使用的参数名（默认 'daoId'）。
  // - tenantIdQueryKeys：读取请求时允许的参数名列表（默认包含 tenantIdParamName + 'daoId' + 'dao_id'）。
  // 注意：
  // - 插件内部仍会把“租户标识”作为第二个参数传给宿主 handleAuthCallback(authCode, tenantId)。
  // - 宿主如需完全更名，请同时确保后台发起 auth_url 时传参一致（例如 ?tenantId=xxx）。
  tenantIdParamName: 'daoId',
  // tenantIdQueryKeys: ['tenantId', 'daoId', 'dao_id'],
};
```
## 属性列表
各个属性的含义如下：

| 属性 | 值 | 说明 | 示例 |
| --- | --- | --- | --- |
| appId | 应用编号 | 开发设置-开发者ID-小程序ID | wxd44b41590ce4de64 |
| appSecret | 应用密钥 | 开发设置-开发者ID-小程序密钥 | 9727cc26585f092f24f1b253813sd13e |
| mchId | 商户编号 | 微信支付商户号 | 1900000109 |
| apiKey | 支付密钥 | 微信支付API密钥 | 9727cc26585f092f24f1b253813sd13e |
| notifyUrl | 回调地址 | 微信支付结果通知地址 | https://api.example.com/pay/notify |
| componentAppId | 第三方平台ID | 开放平台-第三方平台-基本信息 | wx1234567890abcdef |
| componentAppSecret | 第三方平台密钥 | 开放平台-第三方平台-基本信息 | 1234567890abcdef1234567890abcdef |
| componentToken | 消息校验Token | 开放平台-第三方平台-开发配置 | mytoken |
| componentEncodingAESKey | 消息加解密Key | 开放平台-第三方平台-开发配置 | myencodingaeskey |

---

## 宿主侧路由映射（示例）

宿主项目（例如 ddn-hub）建议显式映射以下标准路径：

```js
// server/app/router.js
module.exports = app => {
  const { router } = app;
  const appAuth = app.middleware.auth();

  router.post('/api/v1/wechat/component/notify', app.controller.third.wechatPlatform.notify);
  router.get('/api/v1/wechat/component/:appid/callback', app.controller.third.wechatPlatform.callback);
  router.post('/api/v1/wechat/component/:appid/callback', app.controller.third.wechatPlatform.callback);
  router.get('/api/v1/wechat/component/auth_url', appAuth, app.controller.third.wechatPlatform.getAuthUrl);
  router.get('/api/v1/wechat/component/auth_callback', app.controller.third.wechatPlatform.authCallback);
  router.get('/api/v1/wechat/component/mock_authorize', app.controller.third.wechatPlatform.mockAuthorize);
};
```

说明：controller 内部可以仅做参数校验与统一响应，并转发到 `ctx.service.wechat.platformHttp.*`。

---

## 本地开发：让 ddn-hub 使用本地插件代码（file / link）

当你需要在 `ddn-wechat/` 里改代码，并希望 `ddn-hub/server` 立即使用最新插件逻辑（例如 `config.wechat.getConfig(ctx)` provider）时，可以用下面两种方式切换依赖。

### 方案 A：使用 `file:`（推荐，最简单）

1. 打开宿主项目的依赖文件：`ddn-hub/server/package.json`
2. 将依赖从发布版本改为本地路径（相对 `ddn-hub/server`）：

```json
{
  "dependencies": {
    "@ddn/egg-wechat": "file:../../ddn-wechat"
  }
}
```

3. 在宿主安装依赖：

```bash
cd ddn-hub/server
yarn install
```

4. 验证是否生效（看解析出来的路径/版本）：

```bash
cd ddn-hub/server
node -p "require.resolve('@ddn/egg-wechat/package.json')"
node -p "require('@ddn/egg-wechat/package.json').version"
```

期望：`require.resolve` 指向你本地的 `ddn-wechat`（或其 yarn 缓存产物），版本应与本地 `ddn-wechat/package.json` 一致。

### 方案 B：使用 `yarn link`（更适合频繁改动）

> 注意：link 更“实时”，但也更容易踩到依赖解析/缓存问题；遇到诡异现象优先换回方案 A。

1. 在插件目录创建 link：

```bash
cd ddn-wechat
yarn link
```

2. 在宿主项目链接该包：

```bash
cd ddn-hub/server
yarn link @ddn/egg-wechat
```

3. 验证是否生效：

```bash
cd ddn-hub/server
node -p "require.resolve('@ddn/egg-wechat/package.json')"
```

### 如何恢复到发布版本

无论你用了哪种方式，恢复都建议按以下顺序：

1. 若使用了 `yarn link`：

```bash
cd ddn-hub/server
yarn unlink @ddn/egg-wechat

cd ddn-wechat
yarn unlink
```

2. 把 `ddn-hub/server/package.json` 里的 `@ddn/egg-wechat` 改回发布版本号（例如 `1.0.25`）。
3. 重新安装：

```bash
cd ddn-hub/server
yarn install
```
