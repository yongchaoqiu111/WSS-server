const crypto = require('crypto');

const State = {
  FOLLOWER: 'follower',
  CANDIDATE: 'candidate',
  LEADER: 'leader',
};

class RaftNode {
  constructor(nodeId, peers = []) {
    this.nodeId = nodeId;
    this.state = State.FOLLOWER;
    this.currentTerm = 0;
    this.votedFor = null;
    this.log = [];
    this.commitIndex = -1;
    this.lastApplied = -1;
    this.peers = peers;
    this.nextIndex = {};
    this.matchIndex = {};
    this.stateMachine = null;
    peers.forEach((p) => {
      this.nextIndex[p.id] = 0;
      this.matchIndex[p.id] = -1;
    });
  }

  setPeers(peers) {
    this.peers = peers;
    peers.forEach((p) => {
      this.nextIndex[p.id] = this.log.length;
      this.matchIndex[p.id] = -1;
    });
  }

  setStateMachine(stateMachine) {
    this.stateMachine = stateMachine;
  }

  requestVote(args) {
    const { term, candidateId, lastLogIndex, lastLogTerm } = args;
    let voteGranted = false;

    if (term > this.currentTerm) {
      this.currentTerm = term;
      this.state = State.FOLLOWER;
      this.votedFor = null;
    }

    if (
      term === this.currentTerm &&
      (this.votedFor === null || this.votedFor === candidateId) &&
      this.isLogUpToDate(lastLogIndex, lastLogTerm)
    ) {
      voteGranted = true;
      this.votedFor = candidateId;
    }

    return { term: this.currentTerm, voteGranted };
  }

  appendEntries(args) {
    const { term, prevLogIndex, prevLogTerm, entries, leaderCommit } = args;
    let success = false;

    if (term >= this.currentTerm) {
      this.currentTerm = term;
      this.state = State.FOLLOWER;

      if (
        prevLogIndex === -1 ||
        (prevLogIndex < this.log.length && this.log[prevLogIndex].term === prevLogTerm)
      ) {
        success = true;
        let index = prevLogIndex + 1;
        entries.forEach((entry) => {
          if (index >= this.log.length || this.log[index].term !== entry.term) {
            this.log.splice(index);
            this.log.push(entry);
          }
          index += 1;
        });

        if (leaderCommit > this.commitIndex) {
          this.commitIndex = Math.min(leaderCommit, this.log.length - 1);
        }
      }
    }

    return { term: this.currentTerm, success };
  }

  isLogUpToDate(lastLogIndex, lastLogTerm) {
    const myLastIndex = this.log.length - 1;
    const myLastTerm = myLastIndex >= 0 ? this.log[myLastIndex].term : 0;
    return lastLogTerm > myLastTerm || (lastLogTerm === myLastTerm && lastLogIndex >= myLastIndex);
  }

  submitCommand(command) {
    if (this.state !== State.LEADER) {
      return { success: false, error: 'Not leader' };
    }

    const entry = {
      term: this.currentTerm,
      command,
      timestamp: Date.now(),
      hash: crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex'),
    };

    this.log.push(entry);
    return { success: true, index: this.log.length - 1 };
  }

  async applyLogs() {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied += 1;
      const entry = this.log[this.lastApplied];
      if (this.stateMachine && entry?.command) {
        await this.stateMachine.apply(entry.command);
      }
    }
  }

  getStatus() {
    return {
      nodeId: this.nodeId,
      state: this.state,
      currentTerm: this.currentTerm,
      logLength: this.log.length,
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
      leader: this.state === State.LEADER ? this.nodeId : null,
    };
  }
}

module.exports = { RaftNode, State };
