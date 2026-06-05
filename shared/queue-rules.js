/**
 * 排单档位规则（与设计文档 1.3 一致）
 */
const QUEUE_TIERS = [
  {
    id: 'tier1',
    name: '小额排单',
    amount: 1000,
    exitAmount: 1300,
    profitRate: 0.3,
    ticketCost: 1,
    eligibility: 'none',
  },
  {
    id: 'tier2',
    name: '中额排单',
    amount: 10000,
    exitAmount: 12000,
    profitRate: 0.2,
    ticketCost: 10,
    eligibility: 'direct_referral_10',
  },
  {
    id: 'tier3',
    name: '大额排单',
    amount: 100000,
    exitAmount: 110000,
    profitRate: 0.1,
    ticketCost: 50,
    eligibility: '10_middle_tier',
  },
  {
    id: 'tier4',
    name: '超大额排单',
    amount: 1000000,
    exitAmount: 1080000,
    profitRate: 0.08,
    ticketCost: 500,
    eligibility: '10_large_tier',
  },
];

const TICKET_PRICE_TRX = 100;

function getTierByAmount(amount) {
  return QUEUE_TIERS.find((tier) => tier.amount === amount);
}

function getAllTiers() {
  return QUEUE_TIERS;
}

function getTicketCost(amount) {
  const tier = getTierByAmount(amount);
  if (!tier) throw new Error(`不支持的排单金额: ${amount}`);
  return tier.ticketCost;
}

module.exports = {
  QUEUE_TIERS,
  TICKET_PRICE_TRX,
  getTierByAmount,
  getAllTiers,
  getTicketCost,
};
