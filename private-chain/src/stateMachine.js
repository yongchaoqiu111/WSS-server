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

  async buyTicket(command) {
    const user = await this.requireUser(command.userAddress);
    user.ticketBalance += command.amount;
    user.totalPurchased = (user.totalPurchased || 0) + command.amount;
    await this.db.put(`user:${command.userAddress}`, user);

    await this.db.put(`event:${Date.now()}:buy`, {
      type: 'ticket_purchased',
      userAddress: command.userAddress,
      amount: command.amount,
      txHash: command.txHash,
      at: Date.now(),
    });
    return user;
  }

  async queueOrder(command) {
    const user = await this.requireUser(command.userAddress);
    if (user.ticketBalance < command.ticketCost) {
      throw new Error('排单券不足');
    }

    user.ticketBalance -= command.ticketCost;
    await this.db.put(`user:${command.userAddress}`, user);

    const order = {
      id: command.orderId,
      userAddress: command.userAddress,
      amount: command.amount,
      payAmount: command.payAmount || command.amount,
      ticketCost: command.ticketCost,
      tierId: command.tierId || null,
      tierName: command.tierName || '',
      expectedExit: command.expectedExit || 0,
      status: 'waiting_payment',
      createdAt: Date.now(),
    };
    await this.db.put(`order:${command.orderId}`, order);
    await this.db.put(`event:${Date.now()}:queue`, {
      type: 'order_queued',
      orderId: order.id,
      userAddress: order.userAddress,
      amount: order.amount,
      at: Date.now(),
    });
    return order;
  }

  async confirmTicketPayment(command) {
    const user = await this.requireUser(command.userAddress);
    user.ticketBalance += command.amount;
    await this.db.put(`user:${command.userAddress}`, user);
    const purchase = {
      id: command.purchaseId || `tp_${Date.now()}`,
      userAddress: command.userAddress,
      amount: command.amount,
      payAmount: command.payAmount,
      txHash: command.txHash,
      at: Date.now(),
    };
    await this.db.put(`ticket_purchase:${purchase.id}`, purchase);
    return { user, purchase };
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

    order.status = 'confirmed';
    order.txHash = command.txHash;
    order.confirmedAt = Date.now();
    order.exitEligibleAt = order.confirmedAt + this._fillDelayMs();
    await this.db.put(`order:${command.orderId}`, order);

    const reservoir = await this.ensureReservoir();
    reservoir.currentAmount += order.amount;
    await this.db.put(this.reservoirKey, reservoir);

    await this.grantBurnBonus(order);
    await this.db.put(`event:${Date.now()}:pay`, {
      type: 'payment_confirmed',
      orderId: order.id,
      userAddress: order.userAddress,
      amount: order.payAmount || order.amount,
      txHash: command.txHash,
      at: Date.now(),
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
    return {
      teamCount: user?.teamCount || 0,
      directCount: user?.directCount || 0,
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
          orderId: order.id,
          userAddress: order.userAddress,
          payAmount: order.payAmount || order.amount,
          treasury: PAYMENT_CONFIG.TREASURY_ADDRESS,
          createdAt: order.createdAt,
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
      else if (o.status === 'confirmed') counts.queued += 1;
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
    const min = TICKET_PRICE_CONFIG.MIN_PRICE;
    const max = TICKET_PRICE_CONFIG.MAX_PRICE;
    const payAmount = Math.round((min + Math.random() * (max - min)) * 100) / 100;
    return {
      basePrice: TICKET_PRICE_CONFIG.BASE_PRICE,
      payAmount,
      quantity: 1,
      treasury: 'TREASURY_MULTISIG_PLACEHOLDER',
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
