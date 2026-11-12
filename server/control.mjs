import { fileURLToPath } from 'node:url';

export const credentialFields = [
  'SHOPEE_PARTNER_ID',
  'SHOPEE_PARTNER_KEY',
  'SHOPEE_SHOP_ID',
  'SHOPEE_ACCESS_TOKEN',
  'SHOPEE_REFRESH_TOKEN',
];

export function loadLocalEnvironment(file = fileURLToPath(new URL('../.env', import.meta.url))) {
  if (typeof process.loadEnvFile !== 'function') return 'unsupported';
  try {
    process.loadEnvFile(file);
    return 'loaded';
  } catch (error) {
    return error.code === 'ENOENT' ? 'absent' : 'invalid';
  }
}

export function createControlStatus(env = process.env) {
  const fields = Object.fromEntries(credentialFields.map(field => [field, Boolean(env[field]?.trim())]));
  const missing = credentialFields.filter(field => !fields[field]);
  const configured = missing.length === 0;
  const connectionStatus = configured ? 'pending_validation' : 'not_configured';
  const environment = env.SHOPEE_ENVIRONMENT?.trim() || 'live';
  const pendingData = () => ({ status: 'pending_sync', count: null, lastSyncedAt: null });
  return {
    generatedAt: new Date().toISOString(),
    system: { status: 'healthy', api: 'online', externalApi: 'not_verified', environment: ['live', 'sandbox'].includes(environment) ? environment : 'invalid' },
    connection: { status: connectionStatus, configured, verified: false, fields, missing },
    datasets: {
      orders: pendingData(),
      products: pendingData(),
      inventory: pendingData(),
      metrics: { ...pendingData(), amount: null, currency: null },
    },
    features: {
      overview: { status: 'available' },
      data_center: { status: 'pending_connection' },
      toolbox: { status: 'available' },
      monitoring: { status: 'available' },
      listing_tool: { status: 'available' },
      shop_connection: { status: connectionStatus },
      status_export: { status: 'available' },
    },
  };
}
