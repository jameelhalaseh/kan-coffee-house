// The two payment-method lists must not drift apart.
//
// src/client.config.js is an ES module the browser bundle imports; reporting/payments.js is
// CommonJS the API requires. Neither can import the other without a build step, so the list
// is written twice — and this is the test that makes that safe.
//
// The failure it prevents is specific and bad: a method offered on the till that the API
// rejects means a cashier presses CliQ, takes the customer's money, and the sale 400s with
// the customer standing there. The reverse — a method the API accepts but the till never
// shows — is dead code that reaches the reports under a key nothing has a label for.
const fs = require('fs');
const path = require('path');
const { PAY_KEYS } = require('../payments');

const CONFIG = path.join(__dirname, '..', '..', 'src', 'client.config.js');

// Pull the keys out of the PAYMENTS array literal in the config. Read as text on purpose:
// parsing it as a module would need a transpiler here, and the point is to compare the two
// SOURCES, not two things that were loaded the same way.
function clientPayKeys() {
  const src = fs.readFileSync(CONFIG, 'utf8');
  const block = src.match(/export const PAYMENTS = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error('PAYMENTS array not found in src/client.config.js');
  return Array.from(block[1].matchAll(/\bkey:\s*"([^"]+)"/g)).map((m) => m[1]);
}

describe('payment methods', () => {
  test('the client and the server offer exactly the same methods, in the same order', () => {
    expect(clientPayKeys()).toEqual(PAY_KEYS);
  });

  test('cliq is one of them', () => {
    // Named explicitly so removing it is a deliberate act with a failing test attached,
    // rather than something that quietly falls out of a refactor.
    expect(PAY_KEYS).toContain('cliq');
  });

  test('the keys are lowercase and free of spaces — they are stored in orders_main.pay', () => {
    PAY_KEYS.forEach((k) => expect(k).toMatch(/^[a-z_]+$/));
  });

  test('every method carries both languages and an icon', () => {
    const src = fs.readFileSync(CONFIG, 'utf8');
    const block = src.match(/export const PAYMENTS = \[([\s\S]*?)\n\];/)[1];
    const entries = block.split('\n').filter((l) => l.includes('key:'));
    expect(entries).toHaveLength(PAY_KEYS.length);
    entries.forEach((line) => {
      expect(line).toMatch(/en:\s*"/);
      expect(line).toMatch(/ar:\s*"/);
      expect(line).toMatch(/icon:\s*"/);
      expect(line).toMatch(/settled:\s*(true|false)/);
    });
  });
});
