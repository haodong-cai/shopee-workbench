import './helpers/test-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReturn, logisticsText, reasonText, returnRows } from '../src/returns-model.mjs';

const base = { returnSn: 'R', orderSn: 'O', status: 'PROCESSING', solution: 'return_refund', items: [] };
test('待我处理：回应申请、协商、举证、验收退回商品、可申请赔付，取最早截止', () => {
  const requested = classifyReturn({ ...base, status: 'REQUESTED', solution: 'refund_only', dueDate: 500 });
  assert.deepEqual([requested.stage, requested.due, requested.dueOwner, requested.todos.length], ['action', 500, 'seller', 1]); assert.match(requested.progress, /仅退款，等你回应/);
  const many = classifyReturn({ ...base, status: 'JUDGING', proofStatus: 'PENDING', proofDueDate: 300, negotiationStatus: 'PENDING_RESPOND', offerDueDate: 200, latestSolution: 'REFUND' });
  assert.deepEqual([many.stage, many.due, many.todos.map(t => t.text)], ['action', 200, ['回应买家的协商方案（仅退款）', '上传举证材料']]);
  assert.equal(classifyReturn({ ...base, logisticsStatus: 'LOGISTICS_DELIVERY_DONE', sellerDueDate: 90 }).todos[0].text, '验收退回商品并确认');
  assert.equal(classifyReturn({ ...base, logisticsStatus: 'LOGISTICS_DELIVERY_DONE', validationType: 'warehouse_validation' }).stage, 'progress', '仓库验货不需要卖家验收');
  const comp = classifyReturn({ ...base, status: 'CLOSED', compensationStatus: 'PENDING_REQUEST', compensationDueDate: 70 });
  assert.deepEqual([comp.stage, comp.due, comp.todos[0].text], ['action', 70, '可申请赔付']);
});
test('进行中与已结束：买家寄回截止归买家，已结束不再提示截止', () => {
  const waiting = classifyReturn({ ...base, logisticsStatus: 'LOGISTICS_PENDING_ARRANGE', buyerShipDueDate: 40, dueDate: 10 });
  assert.deepEqual([waiting.stage, waiting.progress, waiting.due, waiting.dueOwner], ['progress', '待买家寄回', 40, 'buyer']);
  assert.deepEqual([classifyReturn({ ...base, logisticsStatus: 'LOGISTICS_PICKUP_DONE' }).progress, classifyReturn({ ...base, status: 'SELLER_DISPUTE' }).progress], ['退回途中', '争议处理中，等平台判定']);
  const refund = classifyReturn({ ...base, solution: 'refund_only', status: 'PROCESSING' });
  assert.deepEqual([refund.stage, refund.progress], ['progress', '等平台退款']);
  for (const status of ['ACCEPTED', 'REFUND_PAID', 'CLOSED', 'CANCELLED']) { const done = classifyReturn({ ...base, status, dueDate: 5, proofStatus: 'PENDING', proofDueDate: 6 }); assert.deepEqual([done.stage, done.due, done.todos.length], ['done', null, 0]); }
});
test('退回物流与原因文案；仅退款不显示物流；未知值原样保留', () => {
  assert.equal(logisticsText({ solution: 'refund_only', logisticsStatus: 'LOGISTICS_PICKUP_DONE' }), '无需退回商品');
  assert.deepEqual(['LOGISTICS_LOST', 'LOGISTICS_PICKUP_FAILED', 'LOGISTICS_DELIVERY_DONE', 'LOGISTICS_READY', 'SOMETHING_NEW'].map(v => logisticsText({ solution: 'return_refund', logisticsStatus: v })), ['退回途中丢件', '退回失败', '已退到', '待买家寄回', 'something new']);
  assert.equal(logisticsText({ solution: null, needsLogistics: false }), '无需退回商品');
  assert.deepEqual([reasonText('WRONG_SIZE'), reasonText('NONE'), reasonText(null), reasonText('BRAND_NEW_CODE')], ['尺码不对', '原因待补', '原因待补', 'brand new code']);
  const rows = returnRows([{ shopId: 1, returns: { rows: [{ ...base, status: 'REQUESTED', dueDate: 9 }] } }, { shopId: 2 }]);
  assert.deepEqual([rows.length, rows[0].shop.shopId, rows[0].stage], [1, 1, 'action']);
});
