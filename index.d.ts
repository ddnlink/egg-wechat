import MPService = require('./app/service/wechat/mp');
import WCSService = require('./app/service/wechat/wcs');
import SignService = require('./app/service/wechat/sign');
import ComponentService = require('./app/service/wechat/component');
import SecurityService = require('./app/service/wechat/security');

declare module 'egg' {
  // extend service
  interface IService {
    wechat: {
      mp: MPService;
      wcs: WCSService;
      sign: SignService;
      component: ComponentService;
      security: SecurityService;
    }
  }
}