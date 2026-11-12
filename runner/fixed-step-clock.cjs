'use strict';

class FixedStepClock {
  constructor(now, { logicHz = 60, smooth = false } = {}) {
    this.period = 1000 / logicHz;
    this.previous = now;
    this.accumulator = this.period;
    this.smooth = smooth;
  }
  takeSteps(now) {
    this.accumulator += Math.min(250, Math.max(0, now - this.previous));
    this.previous = now;
    const due = Math.floor((this.accumulator + 1e-7) / this.period);
    const steps = this.smooth ? Math.min(1, due) : due;
    this.accumulator -= steps * this.period;
    return steps;
  }
}
module.exports = { FixedStepClock };
