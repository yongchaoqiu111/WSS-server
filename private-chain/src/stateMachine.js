const path = require('path');
const { Level } = require('level');
const crypto = require('crypto');
const {
  COMMAND_TYPES,
  RESERVOIR_CONFIG,
  ASSESSMENT_CONFIG,
  TICKET_PRICE_CONFIG,
  BONUS_CONFIG,
  PAYMENT_CONFIG,
  TIMEOUT_CONFIG,
} = require('@mmm/shared');

class ReservoirStateMachine {
  constructor(nodeId) {
    const dbPath = path.join(__dirname, '..', 'data', `${nodeId}-db`);
    this.db = new Level(dbPath, { valueEncoding: 'json' });
    this.reservoirKey = 'reservoir:current';
  }

  async ensureReservoir() {
    try {
      return await this.db.get(this.reservoirKey);
    } catch {
      const reservoir = {
        roundNumber: 1,
        initialTarget: RESERVOIR_CONFIG.INITIAL_TARGET_TRX,
        currentTarget: RESERVOIR_CONFIG.INITIAL_TARGET_TRX,
        currentAmount: 0,
        status: 'filling',
        startedAt: Date.now(),
        expandCount: 0,
      };
      await this.db.put(this.reservoirKey, reservoir);
      return reservoir;
    }
  }

  async apply(command) {
    switch (command.type) {
      case COMMAND_TYPES.REGISTER_USER:
        return this.registerUser(command);
      case COMMAND_TYPES.BUY_TICKET:
        return this.buyTicket(command);
      case COMMAND_TYPES.QUEUE_ORDER:
        return this.queueOrder(command);
      case COMMAND_TYPES.CONFIRM_PAYMENT:
        return this.confirmPayment(command);
      case COMMAND_TYPES.CONFIRM_TICKET_PAYMENT:
        return this.confirmTicketPayment(command);
      case COMMAND_TYPES.DAILY_CHECKIN:
        return this.dailyCheckin(command);
      case COMMAND_TYPES.SUBMIT_THANK_LETTER:
        return this.submitThankLetter(command);
      case COMMAND_TYPES.UPDATE_RESERVOIR:
        return this.updateReservoir(command);
      default:
        console.warn('[StateMachine] Unknown command:', command.type);
        return null;
    }
  }

  async registerUser(command) {
    const key = `user:${command.userAddress}`;
    const existing = await this.getUser(command.userAddress);
    if (existing) return existing;

    const user = {
      address: command.userAddress,
      parentAddress: command.parentAddress || null,
      ticketBalance: 0,
      rewardBalance: 0,
      directCount: 0,
      teamCount: 0,
      lastCheckinAt: 0,
      thankLetterRate: 0,
      createdAt: Date.now(),
    };
    await this.db.put(key, user);
    if (command.parentAddress) {
      const parent = await this.getUser(command.parentAddress);
      if (parent) {
        parent.directCount = (parent.directCount || 0) + 1;
        parent.teamCount = (parent.teamCount || 0) + 1;
        await this.db.put(`user:${command.parentAddress}`, parent);
        await this.db.put(`ref:${command.parentAddress}:${command.userAddress}`, {
          parent: command.parentAddress,
          child: command.userAddress,
          at: Date.now(),
        });
      }
    }
    return user;
  }

  _randomUnitPrice() {
    const { MIN_PRICE, MAX_PRICE } = TICKET_PRICE_CONFIG;
    return Math.round((MIN_PRICE + Math.random() * (MAX_PRICE - MIN_PRICE)) * 100) / 100;
  }

  _ticketPaymentTimeoutMs() {
    return TIMEOUT_CONFIG.PAYMENT_TIMEOUT_HOURS * 3600 * 1000;
  }

  _isTicketPurchaseExpired(purchase) {
    return purchase.expiresAt != null && Date.now() > purchase.expiresAt;
  }

  async _resolveTicketPurchaseStatus(purchase) {
    if (purchase.status === 'pending' && this._isTicketPurchaseExpired(purchase)) {
      purchase.status = 'expired';
      if (purchase.payAmountSun != null) await this._releasePaySlot(purchase.payAmountSun);
      await this.db.put(`ticket_purchase:${purchase.id}`, purchase);
    }
    return purchase;
  }

  async _listReservedPayAmountSuns() {
    const suns = new Set();
    for await (const [, slot] of this.db.iterator({ gte: 'pay_slot:', lte: 'pay_slot:\xff' })) {
      if (slot?.sun != null) suns.add(slot.sun);
    }
    return suns;
  }

  async _releasePaySlot(payAmountSun) {
    try {
      await this.db.del(`pay_slot:${payAmountSun}`);
    } catch (_) {}
  }

  /** 全库唯一支付金额（sun），避免多笔同金额撞单 */
  async _allocateUniquePayAmount({ approxTrx, minTrx, maxTrx, refType, refId }) {
    const used = await this._listReservedPayAmountSuns();
    for (let attempt = 0; attempt < 8000; attempt += 1) {
      const tail = Math.floor(Math.random() * 9999) / 10000;
      let trx = Math.round((approxTrx + tail) * 10000) / 10000;
      if (minTrx != null) trx = Math.max(minTrx, trx);
      if (maxTrx != null) trx = Math.min(maxTrx, trx);
      const sun = Math.round(trx * 1e6);
      if (used.has(sun)) continue;
      await this.db.put(`pay_slot:${sun}`, { sun, trx, refType, refId, at: Date.now() });
      return { payAmount: trx, payAmountSun: sun };
    }
    throw new Error('无法生成唯一支付金额，请稍后重试');
  }

  async _claimTxHash(txHash, meta = {}) {
    if (!txHash || String(txHash).startsWith('listener_auto_')) return;
    const key = `tx_used:${txHash}`;
    try {
      await this.db.get(key);
      throw new Error('该链上交易已用于其他订单');
    } catch (e) {
      if (e.message === '该链上交易已用于其他订单') throw e;
    }
    await this.db.put(key, { ...meta, at: Date.now() });
  }

  /** 创建待支付购票单：self=本机转账认付款方；friend=朋友代付认唯一金额 */
  async buyTicket(command) {
    const treasury = PAYMENT_CONFIG.TREASURY_ADDRESS;
    if (!treasury || treasury.includes('PLACEHOLDER')) {
      throw new Error('服务端收款地址未配置，请在 deploy/.env 设置 TREASURY_ADDRESS 并重启 node1');
    }
    await this.requireUser(command.userAddress);
    const qty = Math.max(1, Math.floor(command.amount || 1));
    const payMode = command.payMode === 'friend' ? 'friend' : 'self';
    const purchaseId = `tp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const createdAt = Date.now();

    let unitPrice;
    let payAmount;
    let payAmountSun;

    if (payMode === 'self') {
      unitPrice = TICKET_PRICE_CONFIG.BASE_PRICE;
      payAmount = unitPrice * qty;
      payAmountSun = Math.round(payAmount * 1e6);
    } else {
      unitPrice = this._randomUnitPrice();
      const approxTrx = Math.round(unitPrice * qty * 100) / 100;
      ({ payAmount, payAmountSun } = await this._allocateUniquePayAmount({
        approxTrx,
        minTrx: TICKET_PRICE_CONFIG.MIN_PRICE * qty,
        maxTrx: TICKET_PRICE_CONFIG.MAX_PRICE * qty + 0.9999,
        refType: 'ticket',
        refId: purchaseId,
      }));
    }

    const purchase = {
      id: purchaseId,
      userAddress: command.userAddress,
      amount: qty,
      unitPrice,
      payAmount,
      payAmountSun,
      payMode,
      matchMode: payMode === 'self' ? 'payer_and_amount' : 'unique_amount',
      expectedPayer: payMode === 'self' ? command.userAddress : null,
      treasury: PAYMENT_CONFIG.TREASURY_ADDRESS,
      status: 'pending',
      createdAt,
      expiresAt: createdAt + this._ticketPaymentTimeoutMs(),
      pollIntervalMs: TIMEOUT_CONFIG.POLL_INTERVAL_MS,
      paymentTimeoutHours: TIMEOUT_CONFIG.PAYMENT_TIMEOUT_HOURS,
    };
    await this.db.put(`ticket_purchase:${purchaseId}`, purchase);
    return purchase;
  }

  _formatReservedAt(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  _eventContentHash(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  async queueOrder(command) {
    const user = await this.requireUser(command.userAddress);
    if (user.ticketBalance < command.ticketCost) {
      throw new Error('排单券不足');
    }

    user.ticketBalance -= command.ticketCost;
    await this.db.put(`user:${command.userAddress}`, user);

    const reservedAt = Date.now();
    const reservedAtText = this._formatReservedAt(reservedAt);
    const eventCore = {
      type: 'order_queued',
      orderId: command.orderId,
      userAddress: command.userAddress,
      ticketCost: command.ticketCost,
      amount: command.amount,
      reservedAt,
      reservedAtText,
    };
    const contentHash = this._eventContentHash(eventCore);

    const order = {
      id: command.orderId,
      userAddress: command.userAddress,
      amount: command.amount,
      payAmount: null,
      payeeAddress: null,
      ticketCost: command.ticketCost,
      tierId: command.tierId || null,
      tierName: command.tierName || '',
      expectedExit: command.expectedExit || 0,
      status: 'queued',
      createdAt: reservedAt,
      queuedAtText: reservedAtText,
      queuedContentHash: contentHash,
      poolContributed: command.amount,
    };
    await this.db.put(`order:${command.orderId}`, order);

    const reservoir = await this.ensureReservoir();
    reservoir.currentAmount += command.amount;
    await this.db.put(this.reservoirKey, reservoir);

    await this.db.put(`event:${reservedAt}:queue`, {
      ...eventCore,
      contentHash,
      poolDelta: command.amount,
      reservoirAfter: reservoir.currentAmount,
    });

    await this.tryMatchQueuedOrders();
    return { order, reservoir, contentHash, reservedAtText };
  }

  /** 资金池满额等条件满足后，才为排队意向单匹配收款方与应付金额 */
  async tryMatchQueuedOrders() {
    const reservoir = await this.ensureReservoir();
    if (reservoir.currentAmount < reservoir.currentTarget) {
      return { matched: 0, reason: 'reservoir_not_full' };
    }

    const queued = [];
    for await (const [, order] of this.db.iterator({ gte: 'order:', lte: 'order:\xff' })) {
      if (order.status === 'queued') queued.push(order);
    }
    queued.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (!queued.length) return { matched: 0 };

    let matched = 0;
    for (const order of queued) {
      const payeeAddress = await this._resolvePayeeForOrder(order);
      const { payAmount, payAmountSun } = await this._allocateUniquePayAmount({
        approxTrx: order.amount,
        minTrx: order.amount,
        maxTrx: order.amount + 0.9999,
        refType: 'order',
        refId: order.id,
      });
      order.status = 'waiting_payment';
      order.payAmount = payAmount;
      order.payAmountSun = payAmountSun;
      order.payeeAddress = payeeAddress;
      order.matchedAt = Date.now();
      await this.db.put(`order:${order.id}`, order);
      await this.db.put(`event:${Date.now()}:match`, {
        type: 'order_matched',
        orderId: order.id,
        payeeAddress,
        payAmount: order.payAmount,
        at: Date.now(),
      });
      matched += 1;
    }
    return { matched };
  }

  async _resolvePayeeForOrder(order) {
    for await (const [, o] of this.db.iterator({ gte: 'order:', lte: 'order:\xff' })) {
      if (o.status === 'exiting' && o.userAddress !== order.userAddress) {
        return o.userAddress;
      }
    }
    return PAYMENT_CONFIG.TREASURY_ADDRESS;
  }

  async confirmTicketPayment(command) {
    const key = `ticket_purchase:${command.purchaseId}`;
    let purchase;
    try {
      purchase = await this.db.get(key);
    } catch {
      throw new Error('购票单不存在');
    }
    if (purchase.status === 'confirmed') {
      const user = await this.getUser(command.userAddress);
      return { user, purchase };
    }
    if (purchase.status === 'expired' || this._isTicketPurchaseExpired(purchase)) {
      throw new Error('购票单已超时');
    }
    if (purchase.status !== 'pending') {
      throw new Error('购票单状态无效');
    }
    if (purchase.userAddress !== command.userAddress) {
      throw new Error('购票单用户不匹配');
    }
    if (command.txHash) {
      await this._claimTxHash(command.txHash, {
        type: 'ticket',
        purchaseId: purchase.id,
        userAddress: command.userAddress,
      });
    }

    const user = await this.requireUser(command.userAddress);
    const qty = purchase.amount;
    user.ticketBalance += qty;
    user.totalPurchased = (user.totalPurchased || 0) + qty;
    await this.db.put(`user:${command.userAddress}`, user);

    purchase.status = 'confirmed';
    purchase.txHash = command.txHash;
    purchase.payerFrom = command.payerFrom || null;
    purchase.confirmedAt = Date.now();
    if (purchase.payAmountSun != null) await this._releasePaySlot(purchase.payAmountSun);
    await this.db.put(key, purchase);

    await this.db.put(`event:${Date.now()}:buy`, {
      type: 'ticket_purchased',
      userAddress: command.userAddress,
      amount: qty,
      payAmount: purchase.payAmount,
      purchaseId: purchase.id,
      txHash: command.txHash,
      at: Date.now(),
    });
    return { user, purchase };
  }

  async getTicketPurchase(purchaseId) {
    try {
      const purchase = await this.db.get(`ticket_purchase:${purchaseId}`);
      return this._resolveTicketPurchaseStatus(purchase);
    } catch {
      return null;
    }
  }

  async reportTicketSelfTx(purchaseId, userAddress, txHash) {
    const purchase = await this.getTicketPurchase(purchaseId);
    if (!purchase) throw new Error('购票单不存在');
    if (purchase.userAddress !== userAddress) throw new Error('购票单用户不匹配');
    if (purchase.payMode !== 'self') throw new Error('仅本机购票可提交转账哈希');
    if (purchase.status === 'confirmed') return { user: await this.getUser(userAddress), purchase };
    if (purchase.status !== 'pending') throw new Error('购票单状态无效');

    const { fetchTronTransferById, verifySelfTicketTransfer } = require('@mmm/shared');
    let payerFrom = purchase.expectedPayer;

    if (!String(txHash).startsWith('demo_')) {
      const tx = await fetchTronTransferById(txHash);
      const check = verifySelfTicketTransfer(purchase, tx);
      if (!check.ok) throw new Error(check.error);
      payerFrom = purchase.expectedPayer;
    } else if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_TX !== '1') {
      throw new Error('演示交易哈希不可用于生产环境');
    }

    return this.confirmTicketPayment({
      type: 'CONFIRM_TICKET_PAYMENT',
      userAddress,
      purchaseId,
      amount: purchase.amount,
      payAmount: purchase.payAmount,
      txHash,
      payerFrom,
    });
  }

  async getLatestPendingTicketPurchase(userAddress) {
    let latest = null;
    for await (const [, purchase] of this.db.iterator({ gte: 'ticket_purchase:', lte: 'ticket_purchase:\xff' })) {
      if (purchase.userAddress === userAddress && purchase.status === 'pending') {
        if (!latest || (purchase.createdAt || 0) > (latest.createdAt || 0)) latest = purchase;
      }
    }
    return latest;
  }

  async dailyCheckin(command) {
    const user = await this.requireUser(command.userAddress);
    const today = new Date().toISOString().slice(0, 10);
    const key = `checkin:${command.userAddress}:${today}`;
    try {
      await this.db.get(key);
      throw new Error('今日已打卡');
    } catch (e) {
      if (e.message === '今日已打卡') throw e;
    }
    await this.db.put(key, { at: Date.now() });
    user.lastCheckinAt = Date.now();
    user.checkinRate = Math.min(100, (user.checkinRate ?? 80) + 10);
    await this.db.put(`user:${command.userAddress}`, user);
    return user;
  }

  async confirmPayment(command) {
    const order = await this.getOrder(command.orderId);
    if (!order) throw new Error('订单不存在');
    if (order.status !== 'waiting_payment') throw new Error('订单状态不可确认');
    if (command.txHash) {
      await this._claimTxHash(command.txHash, {
        type: 'order',
        orderId: order.id,
        userAddress: order.userAddress,
      });
    }

    order.status = 'confirmed';
    order.txHash = command.txHash;
    order.payerFrom = command.payerFrom || null;
    order.confirmedAt = Date.now();
    if (order.payAmountSun != null) await this._releasePaySlot(order.payAmountSun);
    order.exitEligibleAt = order.confirmedAt + this._fillDelayMs();
    await this.db.put(`order:${command.orderId}`, order);

    const reservoir = await this.ensureReservoir();

    await this.grantBurnBonus(order);
    const confirmedAt = Date.now();
    const confirmedAtText = this._formatReservedAt(confirmedAt);
    const payEventCore = {
      type: 'payment_confirmed',
      orderId: order.id,
      userAddress: order.userAddress,
      payAmount: order.payAmount || order.amount,
      tierAmount: order.amount,
      txHash: command.txHash,
      confirmedAt,
      confirmedAtText,
    };
    await this.db.put(`event:${confirmedAt}:pay`, {
      ...payEventCore,
      contentHash: this._eventContentHash(payEventCore),
    });

    return { order, reservoir };
  }

  async submitThankLetter(command) {
    const user = await this.requireUser(command.userAddress);
    const today = new Date().toISOString().slice(0, 10);
    const key = `thank:${command.userAddress}:${today}`;
    try {
      await this.db.get(key);
      throw new Error('今日已提交感谢信');
    } catch (e) {
      if (e.message === '今日已提交感谢信') throw e;
    }
    await this.db.put(key, { content: command.content || '', at: Date.now() });
    user.thankLetterRate = Math.min(100, (user.thankLetterRate || 0) + 15);
    user.checkinRate = user.checkinRate ?? 85;
    await this.db.put(`user:${command.userAddress}`, user);
    return user;
  }

  async grantBurnBonus(order) {
    const user = await this.getUser(order.userAddress);
    if (!user?.parentAddress) return null;
    const parent = await this.getUser(user.parentAddress);
    if (!parent) return null;
    parent.rewardBalance = (parent.rewardBalance || 0) + BONUS_CONFIG.BURN_BONUS_AMOUNT;
    parent.burnBonusTotal = (parent.burnBonusTotal || 0) + BONUS_CONFIG.BURN_BONUS_AMOUNT;
    await this.db.put(`user:${user.parentAddress}`, parent);
    const record = {
      id: `burn_${order.id}`,
      parent: user.parentAddress,
      child: order.userAddress,
      amount: BONUS_CONFIG.BURN_BONUS_AMOUNT,
      orderId: order.id,
      at: Date.now(),
    };
    await this.db.put(`burn:${user.parentAddress}:${order.id}`, record);
    return record;
  }

  _fillDelayMs() {
    if (process.env.DEMO_FAST_EXIT === '1') return 60 * 1000;
    return RESERVOIR_CONFIG.MIN_FILL_DAYS * 86400000;
  }

  _exitDayMs() {
    if (process.env.DEMO_FAST_EXIT === '1') return 30 * 1000;
    return 86400000;
  }

  async processExitQueue() {
    const now = Date.now();
    const exitDays = RESERVOIR_CONFIG.EXIT_DAYS;
    const dayMs = this._exitDayMs();
    let advanced = 0;

    for await (const [key, order] of this.db.iterator({ gte: 'order:', lte: 'order:\xff' })) {
      if (order.status === 'confirmed' && order.exitEligibleAt && now >= order.exitEligibleAt) {
        order.status = 'exiting';
        order.exitStartedAt = now;
        order.exitDay = 0;
        order.exitPaidTotal = 0;
        await this.db.put(key, order);
        advanced += 1;
      } else if (order.status === 'exiting' && order.exitStartedAt) {
        const day = Math.min(exitDays, Math.floor((now - order.exitStartedAt) / dayMs));
        if (day > (order.exitDay || 0)) {
          const daily = (order.expectedExit || order.amount) / exitDays;
          const user = await this.requireUser(order.userAddress);
          const delta = daily * (day - (order.exitDay || 0));
          user.rewardBalance = (user.rewardBalance || 0) + delta;
          order.exitDay = day;
          order.exitPaidTotal = (order.exitPaidTotal || 0) + delta;
          await this.db.put(`user:${order.userAddress}`, user);
          if (day >= exitDays) order.status = 'exited';
          await this.db.put(key, order);
          advanced += 1;
        }
      }
    }
    return { advanced, at: now };
  }

  async getDirectChildren(parentAddress) {
    const children = [];
    for await (const [, value] of this.db.iterator({
      gte: `ref:${parentAddress}:`,
      lte: `ref:${parentAddress}:\xff`,
    })) {
      children.push(value.child);
    }
    return children;
  }

  async getNetworkStats(userAddress) {
    const gen1 = await this.getDirectChildren(userAddress);
    let gen2 = 0;
    const treeLines = [`我 (${this._shortAddr(userAddress)})`];
    for (let i = 0; i < gen1.length; i++) {
      const c = gen1[i];
      treeLines.push(`${i === gen1.length - 1 ? '└──' : '├──'} ${this._shortAddr(c)}`);
      const g2 = await this.getDirectChildren(c);
      gen2 += g2.length;
      for (let j = 0; j < g2.length; j++) {
        const prefix = i === gen1.length - 1 ? '    ' : '│   ';
        treeLines.push(`${prefix}${j === g2.length - 1 ? '└──' : '├──'} ${this._shortAddr(g2[j])}`);
      }
    }
    return {
      gen1Count: gen1.length,
      gen2Count: gen2,
      teamCount: (await this.getUser(userAddress))?.teamCount || gen1.length + gen2,
      treeText: treeLines.join('\n'),
      children: gen1,
    };
  }

  _shortAddr(addr) {
    if (!addr || addr.length < 10) return addr || '—';
    return `${addr.substring(0, 6)}…${addr.substring(addr.length - 4)}`;
  }

  async _countDirectWithMinOrderAmount(parentAddress, minAmount) {
    const children = await this.getDirectChildren(parentAddress);
    const active = new Set(['queued', 'waiting_payment', 'confirmed', 'exiting', 'exited']);
    let count = 0;
    for (const child of children) {
      const orders = await this.getOrdersByUser(child);
      if (orders.some((o) => active.has(o.status) && (o.amount || 0) >= minAmount)) {
        count += 1;
      }
    }
    return count;
  }

  async getPerformance(userAddress) {
    const user = await this.getUser(userAddress);
    const orders = await this.getOrdersByUser(userAddress);
    let totalQueued = 0;
    let totalExited = 0;
    for (const o of orders) {
      totalQueued += o.amount || 0;
      if (o.status === 'exited') totalExited += o.expectedExit || o.amount;
    }
    const burns = await this.getBurnRewards(userAddress);
    const middleTierCount = await this._countDirectWithMinOrderAmount(userAddress, 10000);
    const largeTierCount = await this._countDirectWithMinOrderAmount(userAddress, 100000);
    return {
      teamCount: user?.teamCount || 0,
      directCount: user?.directCount || 0,
      middleTierCount,
      largeTierCount,
      ticketBalance: user?.ticketBalance || 0,
      rewardBalance: user?.rewardBalance || 0,
      totalPurchased: user?.totalPurchased || 0,
      orderCount: orders.length,
      totalQueuedAmount: totalQueued,
      totalExitedAmount: totalExited,
      burnBonusTotal: user?.burnBonusTotal || 0,
      burnRecords: burns.records,
    };
  }

  async getBurnRewards(userAddress) {
    const records = [];
    let pending = 0;
    let withdrawable = 0;
    const user = await this.getUser(userAddress);
    const balance = user?.rewardBalance || 0;
    for await (const [, value] of this.db.iterator({
      gte: `burn:${userAddress}:`,
      lte: `burn:${userAddress}:\xff`,
    })) {
      records.push(value);
    }
    pending = records.reduce((s, r) => s + (r.amount || 0), 0);
    if (balance >= BONUS_CONFIG.MIN_WITHDRAW_AMOUNT) withdrawable = balance;
    return {
      burnBonusAmount: BONUS_CONFIG.BURN_BONUS_AMOUNT,
      minWithdraw: BONUS_CONFIG.MIN_WITHDRAW_AMOUNT,
      rewardBalance: balance,
      pendingTotal: pending,
      withdrawable,
      records: records.sort((a, b) => (b.at || 0) - (a.at || 0)),
    };
  }

  async getPendingPayments() {
    const payments = [];
    for await (const [, order] of this.db.iterator({ gte: 'order:', lte: 'order:\xff' })) {
      if (order.status === 'waiting_payment') {
        payments.push({
          type: 'order',
          orderId: order.id,
          userAddress: order.userAddress,
          payAmount: order.payAmount || order.amount,
          payAmountSun: order.payAmountSun,
          payeeAddress: order.payeeAddress || PAYMENT_CONFIG.TREASURY_ADDRESS,
          treasury: order.payeeAddress || PAYMENT_CONFIG.TREASURY_ADDRESS,
          createdAt: order.createdAt,
          matchedAt: order.matchedAt,
        });
      }
    }
    for await (const [, raw] of this.db.iterator({ gte: 'ticket_purchase:', lte: 'ticket_purchase:\xff' })) {
      const purchase = await this._resolveTicketPurchaseStatus(raw);
      if (purchase.status === 'pending') {
        payments.push({
          type: 'ticket',
          purchaseId: purchase.id,
          userAddress: purchase.userAddress,
          amount: purchase.amount,
          payAmount: purchase.payAmount,
          payAmountSun: purchase.payAmountSun,
          payMode: purchase.payMode || 'friend',
          matchMode: purchase.matchMode,
          expectedPayer: purchase.expectedPayer,
          treasury: purchase.treasury || PAYMENT_CONFIG.TREASURY_ADDRESS,
          createdAt: purchase.createdAt,
          expiresAt: purchase.expiresAt,
        });
      }
    }
    return { treasury: PAYMENT_CONFIG.TREASURY_ADDRESS, payments };
  }

  buildMerkleRoot(records) {
    if (!records.length) return null;
    const leafHash = (record) =>
      crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
    let layer = records.map(leafHash);
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i];
        const right = layer[i + 1] || left;
        next.push(crypto.createHash('sha256').update(left + right).digest('hex'));
      }
      layer = next;
    }
    return `0x${layer[0]}`;
  }

  async getAnchorStatus() {
    const records = [];
    for await (const [, value] of this.db.iterator({ gte: 'event:', lte: 'event:\xff' })) {
      records.push(value);
    }
    records.sort((a, b) => (a.at || 0) - (b.at || 0));
    const merkleRoot = this.buildMerkleRoot(records);
    return {
      recordCount: records.length,
      merkleRoot,
      chain: 'polygon',
      verified: records.length > 0,
      note: records.length ? '本地 Raft 事件已生成 Merkle 根；Polygon 上链需多签' : '暂无事件',
    };
  }

  async updateReservoir(command) {
    const reservoir = await this.ensureReservoir();
    Object.assign(reservoir, command.patch || {});
    await this.db.put(this.reservoirKey, reservoir);
    return reservoir;
  }

  async requireUser(address) {
    const user = await this.getUser(address);
    if (!user) throw new Error('用户未注册');
    return user;
  }

  async getUser(userAddress) {
    try {
      return await this.db.get(`user:${userAddress}`);
    } catch {
      return null;
    }
  }

  async getOrder(orderId) {
    try {
      return await this.db.get(`order:${orderId}`);
    } catch {
      return null;
    }
  }

  async getReservoir() {
    return this.ensureReservoir();
  }

  async getOrdersByUser(userAddress) {
    const orders = [];
    for await (const [key, value] of this.db.iterator({ gte: 'order:', lte: 'order:\xff' })) {
      if (value.userAddress === userAddress) orders.push(value);
    }
    orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return orders;
  }

  async getDashboard(userAddress) {
    const user = await this.getUser(userAddress);
    const orders = await this.getOrdersByUser(userAddress);
    const counts = { queued: 0, paying: 0, earning: 0, done: 0 };
    for (const o of orders) {
      if (o.status === 'waiting_payment') counts.paying += 1;
      else if (o.status === 'queued' || o.status === 'confirmed') counts.queued += 1;
      else if (o.status === 'exiting') counts.earning += 1;
      else if (o.status === 'exited') counts.done += 1;
    }
    const assessment = this.calcAssessment(user);
    return {
      user,
      orderCounts: counts,
      teamCount: user?.teamCount || 0,
      assessment,
      ticketPriceToday: assessment.price,
    };
  }

  calcAssessment(user) {
    if (!user) {
      return { level: 'level1', price: 100, checkinRate: 0, thankRate: 0 };
    }
    const checkinRate = user.checkinRate ?? 85;
    const thankRate = user.thankLetterRate ?? 70;
    const avg = (checkinRate + thankRate) / 2;
    let price = 100;
    let level = 'level1';
    for (const row of ASSESSMENT_CONFIG.LEVELS) {
      if (avg >= row.minRate) {
        price = row.price;
        level = row.level;
        break;
      }
    }
    return { level, price, checkinRate, thankRate, avgRate: avg };
  }

  ticketQuote() {
    const unitPrice = this._randomUnitPrice();
    return {
      basePrice: TICKET_PRICE_CONFIG.BASE_PRICE,
      unitPrice,
      payAmount: unitPrice,
      quantity: 1,
      treasury: PAYMENT_CONFIG.TREASURY_ADDRESS,
      pollIntervalMs: TIMEOUT_CONFIG.POLL_INTERVAL_MS,
      paymentTimeoutHours: TIMEOUT_CONFIG.PAYMENT_TIMEOUT_HOURS,
      paymentTimeoutMs: this._ticketPaymentTimeoutMs(),
    };
  }

  async getEventsSince(timestamp = 0) {
    const events = [];
    for await (const [key, value] of this.db.iterator({ gte: 'event:', lte: 'event:\xff' })) {
      if (value.at >= timestamp) events.push({ key, ...value });
    }
    return events;
  }

  async getAllData() {
    const data = {};
    for await (const [key, value] of this.db.iterator()) {
      data[key] = value;
    }
    return data;
  }

  async close() {
    await this.db.close();
  }
}

module.exports = { ReservoirStateMachine };
