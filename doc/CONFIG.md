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
