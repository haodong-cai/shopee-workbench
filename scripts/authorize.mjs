// 店铺授权命令行工具（工作台页面打不开回调地址时使用）。
//   npm run auth -- link [回跳地址]      生成授权链接
//   npm run auth -- "<授权完成后的完整回跳地址>"   换取令牌并保存到 .local/shopee-auth.json
import { loadLocalEnvironment } from '../server/control.mjs';
import { buildAuthLink, parseCallback, saveAuthorization } from '../server/shop-authorize.mjs';

loadLocalEnvironment();
const [first, second] = process.argv.slice(2);
try {
  if (!first || first === 'link') {
    console.log('\n请在 5 分钟内用浏览器打开下面的链接，登录卖家账号并确认授权：\n');
    console.log(buildAuthLink(second ? { redirect: second } : {}));
    console.log('\n授权完成后，复制浏览器地址栏里的完整地址，运行：\n  npm run auth -- "粘贴的地址"\n（如果工作台正在运行且回跳地址是 127.0.0.1:8787/auth/callback，会自动完成保存，无需这一步。）\n');
  } else {
    const result = await saveAuthorization(parseCallback(first));
    console.log(`授权成功：本次 ${result.shops.length} 家店铺（${result.shops.join(', ')}），当前共 ${result.total} 家。回到工作台点“同步”即可读取数据。`);
  }
} catch (error) {
  console.error(`授权失败：${error.message}${error.code ? `（${error.code}）` : ''}`);
  process.exitCode = 1;
}
