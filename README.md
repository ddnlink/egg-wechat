# @ddn/egg-wechat

[![npm version](https://badge.fury.io/js/@ddn/egg-wechat.svg)](https://badge.fury.io/js/@ddn/egg-wechat)

[微信公众平台](https://mp.weixin.qq.com/)常规的后端服务，献给了不起的[EggJS](https://eggjs.org/zh-cn/)。

本项目 fork 自 [egg-mp](https://github.com/unclexiao/egg-mp)，感谢原作者 [unclexiao](https://github.com/unclexiao) 的贡献。

## 特性
### 微信小程序
- [X] 小程序登录
- [X] 小程序授权
- [X] 小程序支付
- [X] 推送模板消息
- [X] 检测是否含有敏感词
- [ ] 生成二维码/小程序码
- [ ] 接入在线客服消息

### 微信服务号
- [X] 网页授权
- [X] 发送模板消息
- [X] 获取用户基础信息
- [X] 获取用户列表
- [X] 服务号网页支付
- [X] 前端调用JSSDK

### 微信开放平台 (第三方平台)
- [X] 获取 Component Access Token
- [X] 获取预授权码 (PreAuthCode)
- [X] 获取授权方信息 (QueryAuth)
- [X] 发送客服消息
- [X] 获取授权页 URL

## 安装

```bash
$ npm i @ddn/egg-wechat --save
```

## 启用插件

```js
// {app_root}/config/plugin.js
exports.wechat = {
  enable: true,
  package: '@ddn/egg-wechat',
};
```

## 应用配置

```js
// {app_root}/config/config.default.js
exports.wechat = {
  appId: '', // 公众平台应用编号
  appSecret: '', // 公众平台应用密钥
  mchId: '', // 商户平台商家编号
  apiKey: '', // 商户支付密钥
  notifyUrl: '', // 支付结果回调地址
  
  // 开放平台第三方平台配置
  componentAppId: '',
  componentAppSecret: '',
  componentToken: '',
  componentEncodingAESKey: '',

  // ===== 可选：动态注入/覆盖配置（覆盖所有模块） =====
  // 场景：配置存储在数据库/远程配置中心，不希望只靠环境变量。
  // init 支持同步/异步，返回的对象会合并进 wechat 配置。
  init: async (app) => {
    // 例：从你自己的配置系统拉取（伪代码）
    // const ctx = app.createAnonymousContext();
    // const componentAppId = await ctx.service.config.get('wechat.component.appid');
    // const componentAppSecret = await ctx.service.config.get('wechat.component.secret');
    // return { componentAppId, componentAppSecret };
    return {};
  },
  // 或者用静态 override（无需异步）
  // override: { componentAppId: 'wx...', componentAppSecret: '...' },

  // ===== 可选：运行时从统一配置读取（无需把密钥写进 config.wechat） =====
  // 若宿主项目存在 ctx.service.config.unifiedConfig.get(key)（例如 ddn-hub），
  // 插件可在运行时读取 wechat_platform.* 并周期刷新到内存。
  // 注意：这是“读取方式”的开关，不要求你在 config.wechat 里填 appid/secret。
  useUnifiedConfig: true,
  unifiedConfigRefreshIntervalMs: 30000,
};
```

请查看 [doc/CONFIG.md](doc/CONFIG.md) 获取更详细说明.

## 简单实例

### 小程序/公众号

```javascript
async login() {
    const { ctx } = this;
    const { code } = ctx.request.query;
    // 注意命名空间变为 ctx.service.wechat.mp
    let res = await ctx.service.wechat.mp.login(code);
    // {
    //   session_key: "...",
    //   openid: "..."
    // };
}
```

### 开放平台 (Component)

```javascript
async getAuthUrl() {
    const { ctx } = this;
    // 获取授权页 URL
    const url = await ctx.service.wechat.component.getOAuthDomainUrl();
    // ...
}
```

## 基础教程
- [配置项如何找到？](doc/CONFIG.md)
- 如何搭建环境？
- 如何本地调试？
- 登录与授权（获取用户信息）
- 微信支付（小程序、服务号）
- 推送消息（服务通知、模板消息）
- 生成二维码（或小程序码）

## 问题与建议

请在[这里](https://github.com/ddnlink/egg-wechat/issues)向我提出问题

## 开源协议

[MIT](LICENSE)
