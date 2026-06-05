/** 蓄水池核心参数 */
const RESERVOIR_CONFIG = {
  INITIAL_TARGET_TRX: 1_000_000,
  MIN_FILL_DAYS: 15,
  EXIT_DAYS: 7,
  EXPAND_PERCENT: 50,
  MAX_EXPAND_COUNT: 3,
};

const BONUS_CONFIG = {
  BURN_BONUS_AMOUNT: 50,
  MIN_WITHDRAW_AMOUNT: 1300,
};

const TIMEOUT_CONFIG = {
  /** 购票/出场支付等待链上到账的总时限 */
  PAYMENT_TIMEOUT_HOURS: 24,
  /** listener 与 App 轮询间隔（毫秒） */
  POLL_INTERVAL_MS: 15000,
};

const ORDER_STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  WAITING_PAYMENT: 'waiting_payment',
  CONFIRMED: 'confirmed',
  EXITING: 'exiting',
  EXITED: 'exited',
  CANCELLED: 'cancelled',
  TIMEOUT_TRANSFERRED: 'timeout_transferred',
};

const ASSESSMENT_CONFIG = {
  BASE_TICKET_PRICE: 100,
  SERVICE_CENTER_PRICE: 50,
  LEVELS: [
    { minRate: 80, level: 'excellent', price: 30 },
    { minRate: 70, level: 'good', price: 40 },
    { minRate: 60, level: 'pass', price: 50 },
    { minRate: 50, level: 'fail', price: 60 },
    { minRate: 40, level: 'level4', price: 70 },
    { minRate: 30, level: 'level3', price: 80 },
    { minRate: 20, level: 'level2', price: 90 },
    { minRate: 0, level: 'level1', price: 100 },
  ],
};

const SERVICE_CENTER_CONFIG = {
  MIN_PURCHASE_AMOUNT: 1000,
  WHOLESALE_PRICE: 50,
};

const TICKET_PRICE_CONFIG = {
  BASE_PRICE: 100,
  MIN_PRICE: 99.5,
  MAX_PRICE: 100.5,
  DECIMALS: 2,
};

/** Raft 命令类型 */
const PAYMENT_CONFIG = {
  TREASURY_ADDRESS: process.env.TREASURY_ADDRESS || 'TREASURY_MULTISIG_PLACEHOLDER',
};

const COMMAND_TYPES = {
  REGISTER_USER: 'REGISTER_USER',
  BUY_TICKET: 'BUY_TICKET',
  QUEUE_ORDER: 'QUEUE_ORDER',
  CONFIRM_PAYMENT: 'CONFIRM_PAYMENT',
  CONFIRM_TICKET_PAYMENT: 'CONFIRM_TICKET_PAYMENT',
  DAILY_CHECKIN: 'DAILY_CHECKIN',
  SUBMIT_THANK_LETTER: 'SUBMIT_THANK_LETTER',
  UPDATE_RESERVOIR: 'UPDATE_RESERVOIR',
};

const DEFAULT_ANNOUNCEMENTS = [
  { id: 'a1', title: '蓄水池机制说明', content: '满额且满 15 天触发出场，出场分 7 日发放。', at: Date.now() },
  { id: 'a2', title: '排单券价格', content: '零售基准 100 TRX/张，团队考核可享浮动价。', at: Date.now() - 86400000 },
];

module.exports = {
  RESERVOIR_CONFIG,
  BONUS_CONFIG,
  TIMEOUT_CONFIG,
  ORDER_STATUS,
  ASSESSMENT_CONFIG,
  SERVICE_CENTER_CONFIG,
  TICKET_PRICE_CONFIG,
  PAYMENT_CONFIG,
  COMMAND_TYPES,
  DEFAULT_ANNOUNCEMENTS,
};
