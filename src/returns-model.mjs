// 退货 / 退款申请的分类与待办判断（概览、侧栏角标、退货售后页共用）。
export const SOLUTION = { return_refund: ['退货退款', 'info'], refund_only: ['仅退款', 'accent'] };
export const RETURN_STATUS = { REQUESTED: ['待处理', 'warn'], PROCESSING: ['处理中', 'info'], ACCEPTED: ['已同意退款', 'mute'], JUDGING: ['平台审核中', 'warn'], SELLER_DISPUTE: ['争议中', 'bad'], REFUND_PAID: ['已退款', 'mute'], CLOSED: ['已关闭', 'mute'], CANCELLED: ['买家已取消', 'mute'] };
export const DONE = ['ACCEPTED', 'REFUND_PAID', 'CLOSED', 'CANCELLED'];
export const REASON = {
  NOT_RECEIPT: '没收到货', NOT_RECEIVED: '没收到货', WRONG_ITEM: '发错商品', ITEM_DAMAGED: '商品损坏', DIFF_DESC: '与描述不符', MUITAL_AGREE: '与卖家协商一致', MUTUAL_AGREE: '与卖家协商一致',
  OTHER: '其他', CHANGE_MIND: '不想要了', ITEM_MISSING: '少件 / 漏发', EXPECTATION_FAILED: '不符合预期', ITEM_FAKE: '疑似假货', PHYSICAL_DMG: '外观损坏', FUNCTIONAL_DMG: '功能损坏',
  ITEM_WRONGDAMAGED: '发错或损坏', DAMAGED_OTHERS: '其他损坏', DEFECTIVE: '有瑕疵', DAMAGED_PACKAGE: '包装破损', EMPTY_PARCEL: '空包裹', WRONG_SIZE: '尺码不对', WRONG_COLOR: '颜色不对',
  INCOMPLETE: '配件不全', USED: '二手 / 已使用', LOST_IN_TRANSIT: '运输中丢失', SIZE_DEVIATION: '尺码偏差', DESIGN_DEVIATION: '款式与描述不符', CHANGE_OF_MIND: '不想要了'
};
export const reasonText = code => !code || code === 'NONE' ? '原因待补' : REASON[code] || code.replace(/_/g, ' ').toLowerCase();
const PROOF = { PENDING: '待举证', UPLOADED: '已举证', NOT_NEEDED: '无需举证', OVERDUE: '举证已逾期' };
const NEGOTIATION = { PENDING_RESPOND: '待卖家回应', PENDING_BUYER_RESPOND: '待买家回应', TERMINATED: '协商已结束' };
const COMPENSATION = { PENDING_REQUEST: '可申请赔付', NOT_REQUIRED: '无需赔付', REQUESTED: '已申请赔付', APPROVED: '赔付已批准', REJECTED: '赔付被拒', CANCELLED: '赔付已取消', NOT_ELIGIBLE: '不符合赔付' };
const WAREHOUSE = { 1: '待入仓', 2: '仓库拒收', 3: '已入仓', 4: '已取消' };
const REQUEST_TYPE = { 0: '收货后申请', 1: '在途申请（包裹未送达）', 2: '当面拒收退货' };
export const proofText = v => v ? PROOF[v] || v : '—';
export const negotiationText = v => v ? NEGOTIATION[v] || v : '—';
export const compensationText = v => v ? COMPENSATION[v] || v : '—';
export const warehouseText = v => WAREHOUSE[v] || '—';
export const requestTypeText = v => REQUEST_TYPE[v] || '—';
export const offerText = v => !v ? '—' : /RETURN/i.test(v) ? '退货退款' : /REFUND/i.test(v) ? '仅退款' : v;

/** 退回物流状态（字段值较多，按关键字归类，原值放在提示里）。 */
export function logisticsText(row) {
  if (row.solution === 'refund_only') return '无需退回商品';
  const raw = row.logisticsStatus || '';
  if (!raw) return row.needsLogistics === false ? '无需退回商品' : '退回物流待更新';
  if (/LOST/.test(raw)) return '退回途中丢件';
  if (/FAIL/.test(raw)) return '退回失败';
  if (/CANCEL/.test(raw)) return '退回已取消';
  if (/DELIVER(Y|ED)?_?DONE|DELIVERED|RECEIVED|ARRIVED/.test(raw)) return '已退到';
  if (/PICKUP_DONE|IN_TRANSIT|SHIPPED|PICKED/.test(raw)) return '退回途中';
  if (/PENDING|READY|ARRANGE|REQUEST/.test(raw)) return '待买家寄回';
  return raw.replace(/^LOGISTICS_/, '').replace(/_/g, ' ').toLowerCase();
}

const due = value => Number.isFinite(value) && value > 0 ? value : null;
/**
 * stage：action = 需要卖家处理；progress = 进行中，等买家或平台；done = 已结束。
 * todos：卖家要做的事和截止时间（秒）。
 */
export function classifyReturn(row) {
  const todos = [];
  const done = DONE.includes(row.status);
  if (!done) {
    if (row.status === 'REQUESTED') todos.push({ text: '回应申请：同意、提出方案或发起争议', due: due(row.dueDate) });
    if (row.negotiationStatus === 'PENDING_RESPOND') todos.push({ text: `回应买家的协商方案${row.latestSolution ? `（${offerText(row.latestSolution)}）` : ''}`, due: due(row.offerDueDate) });
    if (row.proofStatus === 'PENDING') todos.push({ text: '上传举证材料', due: due(row.proofDueDate) });
    if (row.solution !== 'refund_only' && row.validationType !== 'warehouse_validation' && logisticsText(row) === '已退到' && row.status === 'PROCESSING') todos.push({ text: '验收退回商品并确认', due: due(row.sellerDueDate) });
  }
  if (row.compensationStatus === 'PENDING_REQUEST') todos.push({ text: '可申请赔付', due: due(row.compensationDueDate) });
  const stage = todos.length ? 'action' : done ? 'done' : 'progress';
  let progress;
  if (stage === 'done') progress = (RETURN_STATUS[row.status] || [row.status])[0];
  else if (row.status === 'REQUESTED') progress = row.solution === 'refund_only' ? '买家申请仅退款，等你回应' : '买家申请退货退款，等你回应';
  else if (row.status === 'JUDGING') progress = row.proofStatus === 'UPLOADED' ? '平台审核中，已举证' : '平台审核中';
  else if (row.status === 'SELLER_DISPUTE') progress = '争议处理中，等平台判定';
  else if (row.negotiationStatus === 'PENDING_BUYER_RESPOND') progress = '已提方案，等买家回应';
  else if (row.solution === 'refund_only') progress = '等平台退款';
  else if (row.validationType === 'warehouse_validation') progress = `仓库验货 · ${warehouseText(row.warehouseStatus)}`;
  else progress = logisticsText(row);
  const deadlines = todos.map(t => t.due).filter(Boolean);
  const next = deadlines.length ? Math.min(...deadlines) : stage === 'progress' && row.solution !== 'refund_only' && logisticsText(row) === '待买家寄回' ? due(row.buyerShipDueDate) : null;
  return { stage, todos, progress, due: next, dueOwner: deadlines.length ? 'seller' : next ? 'buyer' : null };
}

export function returnRows(shops) {
  return shops.flatMap(shop => (shop.returns?.rows || []).map(row => ({ ...row, shop, ...classifyReturn(row) })));
}
