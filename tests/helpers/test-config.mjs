// 测试专用的经营参数（虚构数值，与任何真实店铺无关）。必须在导入 server 模块之前加载。
import { fileURLToPath } from 'node:url';
process.env.WORKBENCH_BUSINESS_CONFIG = fileURLToPath(new URL('./business.test.json', import.meta.url));
